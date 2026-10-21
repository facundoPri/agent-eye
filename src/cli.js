import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync, openSync } from 'node:fs';
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
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* the URL is printed anyway */ }
}

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
    port: flags.port ? Number(flags.port) : 0, signal: abort.signal,
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

function stateFile(configPath) { return join(dirname(configPath), 'recording.json'); }

async function cmdRecord(flags) {
  if (!flags.out) throw new UserError('--out FILE is required', { code: 2 });
  const { profile } = requireConfig(flags);
  const abort = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => abort.abort());
  const summary = await recordToFile(profile, flags.out, { durationSec: flags.duration ? Number(flags.duration) : undefined, signal: abort.signal });
  print(flags, summary, `Recorded ${summary.file}\n  ${summary.frames} frames, ${summary.durationSec.toFixed(2)} s, ${summary.measuredFps} fps measured (${summary.width}x${summary.height})${summary.warnings.map((w) => `\n  ! ${w}`).join('')}`);
}

async function cmdStart(flags) {
  if (!flags.out) throw new UserError('--out FILE is required', { code: 2 });
  const { path, profile } = requireConfig(flags);
  const sf = stateFile(path);
  if (existsSync(sf)) {
    const st = JSON.parse(readFileSync(sf, 'utf8'));
    if (alive(st.pid)) throw new UserError(`A recording is already running (pid ${st.pid}, ${st.out}).`, { code: 1, hint: 'Run `agent-eye stop` first.' });
    unlinkSync(sf);
  }
  mkdirSync(dirname(sf), { recursive: true });
  const log = openSync(join(dirname(sf), 'worker.log'), 'a');
  const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-eye.js');
  const args = [bin, '_worker', '--out', resolve(flags.out), '--state', sf, ...(flags.profile ? ['--profile', flags.profile] : [])];
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log], cwd: process.cwd() });
  child.unref();
  for (let i = 0; i < 160; i++) {
    await sleep(150);
    if (existsSync(sf)) { const st = JSON.parse(readFileSync(sf, 'utf8')); if (st.ready) return print(flags, { ok: true, ...st }, `Recording to ${st.out} (pid ${st.pid}). Stop with: agent-eye stop`); }
    if (!alive(child.pid)) break;
  }
  const tail = existsSync(join(dirname(sf), 'worker.log')) ? readFileSync(join(dirname(sf), 'worker.log'), 'utf8').trim().split('\n').slice(-6).join('\n') : '';
  throw new UserError(`The background recorder did not start.\n${tail}`, { code: 3 });
}

async function cmdWorker(flags) {
  const { profile } = requireConfig(flags);
  const out = flags.out, sf = flags.state;
  const abort = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => abort.abort());
  writeFileSync(sf, JSON.stringify({ pid: process.pid, out, profile: profile.name, ready: false }));
  const onStarted = (startedAtMs) => writeFileSync(sf, JSON.stringify({ pid: process.pid, out, profile: profile.name, ready: true, startedAtMs }));
  try { await recordToFile(profile, out, { signal: abort.signal, onStarted }); } finally { if (existsSync(sf)) unlinkSync(sf); }
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

async function cmdStop(flags) {
  const { path } = requireConfig(flags);
  const sf = stateFile(path);
  if (!existsSync(sf)) throw new UserError('No background recording is running.', { code: 1 });
  const st = JSON.parse(readFileSync(sf, 'utf8'));
  process.kill(st.pid, 'SIGINT');
  for (let i = 0; i < 200 && alive(st.pid); i++) await sleep(150);
  if (alive(st.pid)) throw new UserError(`The recorder (pid ${st.pid}) did not stop.`, { code: 1 });
  const side = st.out.replace(/\.[^.]+$/, '') + '.json';
  const summary = existsSync(side) ? JSON.parse(readFileSync(side, 'utf8')) : { file: st.out };
  print(flags, summary, `Stopped. ${summary.file}${summary.frames ? `\n  ${summary.frames} frames, ${summary.durationSec.toFixed(2)} s, ${summary.measuredFps} fps measured` : ''}`);
}

async function cmdStatus(flags) {
  const path = findConfigPath();
  const sf = path && stateFile(path);
  const st = sf && existsSync(sf) ? JSON.parse(readFileSync(sf, 'utf8')) : null;
  const running = !!st && alive(st.pid);
  print(flags, { running, ...(running ? st : {}) }, running ? `Recording to ${st.out} (pid ${st.pid})` : 'Not recording.');
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
      case 'snapshot': { if (!flags.out) throw new UserError('--out FILE.jpg is required', { code: 2 }); const { profile } = requireConfig(flags); const r = await takeSnapshot(profile, flags.out, { warmupMs: flags.warmup ? Number(flags.warmup) : undefined }); print(flags, r, `Saved ${r.file}`); return; }
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
