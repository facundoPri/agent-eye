import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, readFileSync, openSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configPathForWrite, emptyConfig, findConfigPath, globalConfigPath, getProfile, loadConfig, normalizeProfile, saveConfig, upsertProfile } from './config.js';
import { listDevices, macCameraModes } from './devices.js';
import { assertSupported } from './validate.js';
import { doctor, macCameraAccess } from './doctor.js';
import { recordToFile, takeSnapshot } from './capture.js';
import { serveConfigurator } from './server.js';
import { UserError, sleep } from './util.js';
import { claim, listenControl, readState, recorderStatus, removeState, statePath, stopRecorder, updateState } from './background.js';
import { installSkill, projectRootFor, skillStatus } from './skill.js';

const HELP = `agent-eye: eyes for agents. Configure, preview and record cameras.

  agent-eye setup                      first-run check (tools, permissions, cameras) and first profile
  agent-eye doctor                     check tools and connected cameras
  agent-eye devices [--caps]           list cameras (Mac webcams, Android phones over USB)
  agent-eye configure                  open the browser to pick camera, resolution, fps, zoom, framing
  agent-eye configure --set JSON       same without a browser; JSON, @file.json or - for stdin
  agent-eye preview                    open the browser on the saved profile to check or adjust it
  agent-eye show                       print the saved profile
  agent-eye snapshot --out f.jpg       one full-resolution still with the saved framing
  agent-eye record --out v.mp4 --duration 30
  agent-eye start --out v.mp4          record in the background
  agent-eye stop                       stop the background recording and print its summary
  agent-eye status                     is a background recording running?
  agent-eye skill [--install]          is the agent skill in this project? --install adds or updates it

Options: --profile NAME  --name NAME  --global  --no-open  --port N  --json  --text
While a browser page (setup, configure, preview) is open it holds the camera; close it before recording.
Output is JSON when stdout is not a terminal (or with --json). Exit codes: 0 ok, 1 error,
2 not configured or bad input, 3 camera or tool problem.`;

const BOOL = new Set(['json', 'text', 'caps', 'global', 'no-open', 'help', 'install']);

export function parseArgs(argv) {
  const flags = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-') { rest.push(a); continue; }
    if (!a.startsWith('--')) { rest.push(a); continue; }
    const [k, v] = a.slice(2).split(/=(.*)/s, 2);
    if (v !== undefined) flags[k] = v;
    else if (BOOL.has(k)) flags[k] = true;
    else { flags[k] = argv[++i]; if (flags[k] === undefined) throw new UserError(`--${k} needs a value`, { code: 2 }); }
  }
  return { cmd: rest[0], flags, rest: rest.slice(1) };
}

const jsonMode = (flags) => flags.json || (!flags.text && !process.stdout.isTTY);
const print = (flags, obj, text) => console.log(jsonMode(flags) ? JSON.stringify(obj, null, 2) : text ?? JSON.stringify(obj, null, 2));

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  // A missing opener (no xdg-open) fails asynchronously; the URL is printed anyway.
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* same */ }
}

/** A numeric flag, checked before any camera is opened. */
function numFlag(flags, name, ok, what) {
  const raw = flags[name];
  if (raw === undefined) return undefined;
  const v = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(v) || !ok(v)) throw new UserError(`--${name} must be ${what} (got "${raw}").`, { code: 2 });
  return v;
}
const durationFlag = (flags) => numFlag(flags, 'duration', (v) => v > 0 && v <= 2e6, 'a number of seconds greater than 0');

/**
 * Abort `abort` on Ctrl-C, kill or hang-up so the camera is released cleanly. A second signal
 * quits at once, for a step that cannot be interrupted (a hung adb push).
 */
function abortOnSignals(abort) {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      if (abort.signal.aborted) { console.error('Interrupted.'); process.exit(130); }
      abort.abort();
    });
  }
}

export const summaryText = (s) => `${s.file}${s.frames ? `\n  ${s.frames} frames, ${s.durationSec.toFixed(2)} s, ${s.measuredFps} fps measured (${s.width}x${s.height})` : ''}${(s.warnings ?? []).map((w) => `\n  ! ${w}`).join('')}`;
const resultError = (r) => new UserError(r.error, { code: r.exitCode ?? 1, hint: r.hint });

function requireConfig(flags) {
  const path = findConfigPath();
  const cfg = loadConfig(path);
  if (!cfg || !Object.keys(cfg.profiles).length) {
    throw new UserError('Agent Eye is not configured yet.', { code: 2, hint: 'Run `agent-eye setup` (or `agent-eye configure`) once to choose a camera.' });
  }
  return { path, cfg, profile: getProfile(cfg, flags.profile) };
}

async function readSetInput(value) {
  if (value === '-') return readFileSync(0, 'utf8');
  if (value.startsWith('@')) return readFileSync(value.slice(1), 'utf8');
  return value;
}

async function cmdConfigureJson(flags) {
  let raw;
  try { raw = JSON.parse(await readSetInput(flags.set)); } catch (e) { throw new UserError(`--set is not valid JSON: ${e.message}`, { code: 2 }); }
  const name = flags.name ?? raw.name ?? 'default';
  const { name: _n, confirmedAt: _c, ...body } = raw;
  const profile = normalizeProfile(body);
  const { devices } = await listDevices({ capabilities: true });
  const dev = devices.find((d) => d.id === profile.source);
  if (!dev) throw new UserError(`Camera ${profile.source} is not connected.`, { code: 3, hint: `Connected: ${devices.map((d) => d.id).join(', ') || 'none'}` });
  assertSupported(profile, dev, dev.kind === 'mac' ? await macCameraModes(dev.index) : []);
  const path = configPathForWrite({ global: !!flags.global });
  const cfg = upsertProfile(loadConfig(path) ?? emptyConfig(), name, profile, { makeDefault: true });
  saveConfig(path, cfg);
  print(flags, { ok: true, name, configPath: path, profile: cfg.profiles[name] }, `Saved profile "${name}" to ${path}`);
}

async function cmdWeb(flags, mode) {
  const path = mode === 'preview' ? requireConfig(flags).path : configPathForWrite({ global: !!flags.global });
  const profileName = mode === 'preview' ? getProfile(loadConfig(path), flags.profile).name : flags.profile;
  // Ctrl-C or a kill must release the camera: stop the preview before exiting.
  const abort = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => abort.abort());
  await serveConfigurator({
    configPath: path, projectRoot: projectRootFor(path, globalConfigPath()), mode, profileName,
    port: numFlag(flags, 'port', (v) => Number.isInteger(v) && v >= 0 && v <= 65535, 'a port number') ?? 0, signal: abort.signal,
    onReady: (url) => {
      console.error(`${mode === 'preview' ? 'Preview' : 'Configure'} is open at:\n  ${url}\nThe camera stays busy until you press "Close" in the page or Ctrl-C here.`);
      if (!flags['no-open']) openBrowser(url);
    },
  });
  const cfg = loadConfig(path);
  print(flags, { ok: true, configPath: path, default: cfg?.default ?? null, profiles: Object.keys(cfg?.profiles ?? {}) }, 'Done.');
}

function cmdSkill(flags) {
  const root = projectRootFor(findConfigPath(), globalConfigPath());
  const r = flags.install ? installSkill(root) : skillStatus(root);
  const lines = r.targets.map((t) => `  ${t.state === 'current' ? '✓' : t.state === 'outdated' ? '!' : '·'} ${t.relative} (${t.state})`);
  const tip = !flags.install && !r.upToDate ? '\nInstall or update with: agent-eye skill --install' : '';
  print(flags, r, `Agent skill in ${r.projectRoot}\n${lines.join('\n')}${tip}`);
}

async function cmdSetup(flags) {
  const report = await doctor();
  const interactive = process.stdout.isTTY && !jsonMode(flags);
  if (interactive) {
    console.log('Agent Eye setup\n');
    for (const c of report.checks) console.log(`  ${c.ok ? '✓' : c.name.includes('Android') || c.name.includes('configuration') ? '·' : '✗'} ${c.name}: ${c.detail}${c.fix ? `  → ${c.fix}` : ''}`);
  }
  if (!report.ok) throw new UserError('Some required tools are missing. Install them and run `agent-eye setup` again.', { code: 3, hint: report.checks.filter((c) => !c.ok && c.fix && !c.name.includes('configuration')).map((c) => `${c.name}: ${c.fix}`).join('\n') });

  const access = await macCameraAccess();
  if (interactive) console.log(`  ${access.ok ? '✓' : access.ok === false ? '✗' : '·'} Mac camera permission: ${access.detail}`);
  const { devices, problems } = await listDevices();
  if (interactive) {
    for (const p of problems) console.log(`  ✗ Phone ${p.model}: ${p.hint}`);
    if (!devices.some((d) => d.kind === 'android') && !problems.length) console.log('  · No Android phone: connect it with USB and enable USB debugging if you want to use it.');
  }
  const configured = !!findConfigPath() && Object.keys(loadConfig(findConfigPath())?.profiles ?? {}).length > 0;
  if (!interactive) return print(flags, { ok: true, configured, macCameraAccess: access, devices, problems, skill: skillStatus(projectRootFor(findConfigPath() ?? configPathForWrite({ global: !!flags.global }), globalConfigPath())), next: configured ? null : 'agent-eye configure' });
  const skill = skillStatus(projectRootFor(findConfigPath() ?? configPathForWrite({ global: !!flags.global }), globalConfigPath()));
  if (!skill.upToDate) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const verb = skill.installed ? 'Update' : 'Add';
    const ans = (await rl.question(`\n${verb} the agent-eye skill in ${skill.projectRoot} so agents know how to use the camera? [Y/n] `)).trim().toLowerCase();
    rl.close();
    if (ans !== 'n') console.log(`  ✓ wrote ${installSkill(skill.projectRoot).written.join(', ')}`);
  }
  if (configured) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = (await rl.question('\nA profile already exists. Open the browser to review it? [Y/n] ')).trim().toLowerCase();
    rl.close();
    if (ans === 'n') return;
    return cmdWeb(flags, 'preview');
  }
  console.log('\nNo profile yet: opening the browser to create one.');
  return cmdWeb(flags, 'configure');
}

async function cmdRecord(flags) {
  if (!flags.out) throw new UserError('--out FILE is required', { code: 2 });
  const durationSec = durationFlag(flags);
  const { profile } = requireConfig(flags);
  const abort = new AbortController();
  abortOnSignals(abort);
  const summary = await recordToFile(profile, flags.out, { durationSec, signal: abort.signal });
  print(flags, summary, `Recorded ${summaryText(summary)}`);
}

async function cmdStart(flags) {
  if (!flags.out) throw new UserError('--out FILE is required', { code: 2 });
  const { path, profile } = requireConfig(flags);
  const sf = statePath(path);
  const id = randomBytes(16).toString('hex');
  const out = resolve(flags.out);
  await claim(sf, { id, out, profile: profile.name });
  const logPath = join(dirname(sf), 'worker.log');
  let child;
  try {
    const log = openSync(logPath, 'a');
    const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-eye.js');
    const args = [bin, '_worker', '--id', id, '--out', out, '--state', sf, ...(flags.profile ? ['--profile', flags.profile] : [])];
    child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log], cwd: process.cwd() });
    closeSync(log);
  } catch (e) {
    await removeState(sf, id); // an unused claim must not block the next start
    throw e;
  }
  // The worker is detached, so a Ctrl-C here would not reach it: cancel it explicitly.
  const abort = new AbortController();
  abortOnSignals(abort);
  let exited = false;
  child.on('exit', () => { exited = true; }).on('error', () => { exited = true; });
  child.unref();
  const tail = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').slice(-6).join('\n') : '');
  for (const deadline = Date.now() + 45000; Date.now() < deadline;) {
    await sleep(150);
    if (abort.signal.aborted) {
      const res = await stopRecorder(sf).catch(() => null);
      throw res?.ok === false ? resultError(res) : new UserError('Interrupted; the background recording was stopped.', { code: 1 });
    }
    const wasExited = exited;
    const st = readState(sf);
    if (!st) throw new UserError('The background recording was stopped before it started.', { code: 1 });
    if (st.id !== id) throw new UserError('The background recording was taken over by another command.', { code: 1 });
    if (st.result) { await removeState(sf, id); throw resultError(st.result); }
    if (st.ready) return print(flags, { ok: true, pid: st.pid, out: st.out, profile: st.profile, startedAtMs: st.startedAtMs }, `Recording to ${st.out} (pid ${st.pid}). Stop with: agent-eye stop`);
    if (wasExited) { await removeState(sf, id); throw new UserError(`The background recorder exited while starting.\n${tail()}`, { code: 3 }); }
  }
  // Too slow: cancel the start so the worker does not hold the camera behind our back.
  await stopRecorder(sf).catch(() => null);
  throw new UserError(`The background recorder did not start within 45 s.\n${tail()}`, { code: 3 });
}

async function cmdWorker(flags) {
  const { id, out, state: sf } = flags;
  const abort = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => abort.abort());
  const info = { pid: process.pid, out, ready: false };
  const ctl = await listenControl(id, { info: () => info, onStop: () => abort.abort() });
  await updateState(sf, id, { pid: process.pid, port: ctl.port });
  let result;
  try {
    const { profile } = requireConfig(flags);
    info.profile = profile.name;
    const onStarted = (startedAtMs) => {
      Object.assign(info, { ready: true, startedAtMs });
      updateState(sf, id, { ready: true, startedAtMs }).catch((e) => console.error(e.message));
    };
    result = { ok: true, summary: await recordToFile(profile, out, { signal: abort.signal, onStarted }) };
  } catch (e) {
    result = { ok: false, error: e.message, ...(e.hint ? { hint: e.hint } : {}), exitCode: e instanceof UserError ? e.exitCode : 1 };
    console.error(`${new Date().toISOString()} ${out}: ${e.message}`);
  }
  await updateState(sf, id, { result }); // read by `stop` or `status` if nobody is connected now
  ctl.finish(result);
  if (!result.ok) process.exitCode = result.exitCode;
}

async function cmdStop(flags) {
  const { path } = requireConfig(flags);
  const res = await stopRecorder(statePath(path));
  if (!res) throw new UserError('The background recorder ended without reporting a result; no valid video is known.', { code: 1, hint: `See ${join(dirname(path), 'worker.log')}.` });
  if (!res.ok) throw resultError(res);
  print(flags, res.summary, `Stopped. ${summaryText(res.summary)}`);
}

async function cmdStatus(flags) {
  const path = findConfigPath();
  const r = path ? await recorderStatus(statePath(path)) : { running: false };
  const last = r.last && (r.last.ok ? `the last background recording finished: ${r.last.summary.file}` : `the last background recording failed: ${r.last.error}`);
  print(flags, r, r.running ? `Recording to ${r.out}${r.pid ? ` (pid ${r.pid})` : ''}${r.ready ? '' : ', still starting'}` : `Not recording${last ? `; ${last}` : ''}.`);
}

export async function main(argv) {
  let flags = {};
  try {
    const parsed = parseArgs(argv);
    flags = parsed.flags;
    const { cmd } = parsed;
    if (!cmd || cmd === 'help' || flags.help) return console.log(HELP);
    switch (cmd) {
      case 'setup': return await cmdSetup(flags);
      case 'doctor': { const r = await doctor(); print(flags, r, r.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}${c.fix ? `  → ${c.fix}` : ''}`).join('\n')); process.exitCode = r.ok ? 0 : 3; return; }
      case 'devices': { const r = await listDevices({ capabilities: !!flags.caps }); print(flags, r, [...r.devices.map((d) => `${d.id}\n    ${d.name}${d.maxSize ? `, up to ${d.maxSize}` : ''}`), ...r.problems.map((p) => `! ${p.model}: ${p.hint}`)].join('\n') || 'No cameras found.'); return; }
      case 'configure': return flags.set !== undefined ? await cmdConfigureJson(flags) : await cmdWeb(flags, 'configure');
      case 'preview': return await cmdWeb(flags, 'preview');
      case 'show': { const { path, profile } = requireConfig(flags); print(flags, { configPath: path, profile }, `${path}\n${JSON.stringify(profile, null, 2)}`); return; }
      case 'snapshot': { if (!flags.out) throw new UserError('--out FILE.jpg is required', { code: 2 }); const warmupMs = numFlag(flags, 'warmup', (v) => v >= 0 && v <= 60000, 'milliseconds between 0 and 60000'); const { profile } = requireConfig(flags); const abort = new AbortController(); abortOnSignals(abort); const r = await takeSnapshot(profile, flags.out, { warmupMs, signal: abort.signal }); print(flags, r, `Saved ${r.file}`); return; }
      case 'record': return await cmdRecord(flags);
      case 'start': return await cmdStart(flags);
      case 'stop': return await cmdStop(flags);
      case 'status': return await cmdStatus(flags);
      case 'skill': return cmdSkill(flags);
      case '_worker': return await cmdWorker(flags);
      default: throw new UserError(`Unknown command "${cmd}". Run \`agent-eye help\`.`, { code: 2 });
    }
  } catch (e) {
    const err = e instanceof UserError ? e : Object.assign(new Error(e?.message ?? String(e)), { exitCode: 1 });
    if (jsonMode(flags)) console.log(JSON.stringify({ ok: false, error: err.message, ...(err.hint ? { hint: err.hint } : {}), exitCode: err.exitCode ?? 1 }));
    else console.error(`Error: ${err.message}${err.hint ? `\n${err.hint}` : ''}`);
    if (!(e instanceof UserError) && process.env.AGENT_EYE_DEBUG) console.error(e.stack);
    process.exitCode = err.exitCode ?? 1;
  }
}
