import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, readFileSync, openSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configPathForWrite, emptyConfig, findConfigPath, globalConfigPath, getProfile, loadConfig, normalizeProfile, saveConfig, upsertProfile } from './config.js';
import { androidCameras, listDevices, macCameraModes } from './devices.js';
import { assertSupported } from './validate.js';
import { doctor, macCameraAccess } from './doctor.js';
import { recordToFile, takeSnapshot } from './capture.js';
import { startSession, parseAndroidSource } from './session.js';
import { frameSelection, pictureToView, viewToCamera } from './framing.js';
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
      [--name N] [--default]           writes only profile N, creating it if new (--profile N, or "name" in
                                       the JSON, is the same); without a name, the default profile.
                                       --default makes N the default
  agent-eye configure --update JSON    change only these fields of a profile (null removes one: {"focus": null})
  agent-eye preview                    open the browser on the saved profile to check or adjust it
  agent-eye frame --region x,y,w,h     frame that part of the picture (fractions of what \`snapshot\` shows):
                                       most camera zoom that keeps it centred, a crop for the rest, focus on it
  agent-eye focus [scan|auto|D]        scan: autofocus once on --region (or the focus area, or the picture)
      [--region x,y,w,h]               and fix it there; auto: continuous autofocus (on --region if given);
                                       D: fixed at D diopters (1/m: 4 = 25 cm)
  agent-eye show                       print the saved profile
  agent-eye snapshot --out f.jpg       one full-resolution still with the saved framing
  agent-eye record --out v.mp4 --duration 30
  agent-eye start --out v.mp4          record in the background
  agent-eye stop [--tail S]            stop the background recording (S more seconds first) and print its summary
  agent-eye status                     is a background recording running?
  agent-eye skill [--install]          is the agent skill in this project? --install adds or updates it

Options: --profile NAME  --name NAME  --global  --no-open  --port N  --json  --text
While a browser page (setup, configure, preview) is open it holds the camera; close it before recording.
Output is JSON when stdout is not a terminal (or with --json). Exit codes: 0 ok, 1 error,
2 not configured or bad input, 3 camera or tool problem.`;

const BOOL = new Set(['json', 'text', 'caps', 'global', 'no-open', 'help', 'install', 'default']);

export function parseArgs(argv) {
  const flags = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-') { rest.push(a); continue; }
    if (!a.startsWith('--')) { rest.push(a); continue; }
    const [k, v] = a.slice(2).split(/=(.*)/s, 2);
    if (v !== undefined) flags[k] = v;
    else if (BOOL.has(k)) flags[k] = true;
    else {
      flags[k] = argv[++i];
      // `--name --set {…}` must not take "--set" as the name and drop the JSON.
      if (flags[k] === undefined || flags[k].startsWith('--')) throw new UserError(`--${k} needs a value`, { code: 2 });
    }
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
  const merge = flags.update !== undefined;
  const opt = merge ? 'update' : 'set';
  let raw;
  try { raw = JSON.parse(await readSetInput(flags[opt])); } catch (e) { throw new UserError(`--${opt} is not valid JSON: ${e.message}`, { code: 2 }); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new UserError(`--${opt} must be a JSON object.`, { code: 2 });
  if (merge) {
    // Only the given fields change; null removes one (back to its default, e.g. "focus": null is autofocus).
    const { profile: current } = requireConfig({ profile: flags.name ?? flags.profile ?? raw.name });
    const { name: _cn, confirmedAt: _cc, ...base } = current;
    raw = { ...base, ...raw, name: current.name };
    for (const k of Object.keys(raw)) if (raw[k] === null) delete raw[k];
  }
  if (flags.name && flags.profile && flags.name !== flags.profile) {
    throw new UserError(`--name "${flags.name}" and --profile "${flags.profile}" name different profiles; pass one.`, { code: 2 });
  }
  if (flags.default !== undefined && flags.default !== true && flags.default !== 'true') {
    throw new UserError(`--default takes no value (got "${flags.default}"); leave it out to keep the current default.`, { code: 2 });
  }
  if (raw.name !== undefined && raw.name !== null && typeof raw.name !== 'string') throw new UserError(`"name" in --${opt} JSON must be a string.`, { code: 2 });
  const { name: _n, confirmedAt: _c, ...body } = raw;
  const profile = normalizeProfile(body);
  const { devices } = await listDevices({ capabilities: true });
  const dev = devices.find((d) => d.id === profile.source);
  if (!dev) throw new UserError(`Camera ${profile.source} is not connected.`, { code: 3, hint: `Connected: ${devices.map((d) => d.id).join(', ') || 'none'}` });
  assertSupported(profile, dev, dev.kind === 'mac' ? await macCameraModes(dev.index) : []);
  // Read just before writing: a save from the browser during device discovery must not be lost.
  const path = configPathForWrite({ global: !!flags.global });
  const current = loadConfig(path) ?? emptyConfig();
  // Only the named profile is written (created if new); without a name, the current default.
  // The default selection changes only with --default, or when there is no valid one.
  const name = flags.name ?? flags.profile ?? raw.name ?? current.default ?? 'default';
  const created = !Object.hasOwn(current.profiles ?? {}, name);
  const cfg = upsertProfile(current, name, profile, { makeDefault: !!flags.default });
  saveConfig(path, cfg);
  print(flags, { ok: true, name, created, default: cfg.default, configPath: path, profile: cfg.profiles[name] },
    `${created ? 'Created' : 'Updated'} profile "${name}" in ${path}; the default profile is "${cfg.default}".`);
}

/** --region x,y,w,h: fractions of the picture `snapshot` shows (after the crop), in view coordinates. */
function regionFlag(flags, profile) {
  if (flags.region === undefined) return undefined;
  const v = String(flags.region).split(',').map((t) => (t.trim() === '' ? NaN : Number(t)));
  const [x, y, w, h] = v;
  if (v.length !== 4 || !v.every(Number.isFinite) || x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.0001 || y + h > 1.0001) {
    throw new UserError(`--region must be x,y,w,h as fractions of the picture (0-1), inside it (got "${flags.region}").`, { code: 2 });
  }
  const r = pictureToView({ x, y, w, h }, profile.crop);
  const r4 = (n) => Math.round(n * 10000) / 10000;
  return { x: r4(r.x), y: r4(r.y), w: r4(r.w), h: r4(r.h) };
}

/** Write `changes` into the profile (read just before writing). */
function saveChanges(path, name, changes) {
  const cfg = loadConfig(path);
  const { confirmedAt: _c, ...current } = cfg.profiles[name];
  const next = { ...current, ...changes };
  for (const k of Object.keys(next)) if (next[k] === null) delete next[k];
  const out = upsertProfile(cfg, name, next);
  saveConfig(path, out);
  return out.profiles[name];
}

/** The phone camera of a profile, opened with nothing recorded, for framing and focusing commands. */
async function withPhone(flags, fn) {
  const { path, profile } = requireConfig(flags);
  if (!profile.source.startsWith('android:')) throw new UserError('Framing and focus need a phone camera; for a Mac camera set "crop" with `configure --update`.', { code: 2 });
  const { serial, cameraId } = parseAndroidSource(profile.source);
  const caps = (await androidCameras(serial)).find((c) => c.id === cameraId);
  if (!caps) throw new UserError(`The phone has no camera ${cameraId}.`, { code: 3 });
  const abort = new AbortController();
  abortOnSignals(abort);
  const session = await startSession(profile, ['-f', 'null', '-'], { waitReady: true, signal: abort.signal });
  try { return await fn({ path, profile, caps, session }); } finally { await session.stop(); }
}

const cmOf = (d) => (d > 0 ? Math.round(100 / d) : null);

async function cmdFrame(flags) {
  const { profile: p0 } = requireConfig(flags);
  const sel = regionFlag(flags, p0);
  if (!sel) throw new UserError('--region x,y,w,h is required: the part of the picture to frame, as fractions of what `snapshot` shows.', { code: 2 });
  await withPhone(flags, async ({ path, profile, caps, session }) => {
    const r = await frameSelection(session, profile, sel, caps, { onStep: (m) => { if (!jsonMode(flags)) console.error(m); } });
    const saved = saveChanges(path, profile.name, r.changes);
    const out = { ok: true, profile: profile.name, saved, lens: r.lens, digitalCrop: r.digitalCrop, scan: r.scan, notes: r.notes };
    print(flags, out, [`Framed "${profile.name}": camera zoom ${saved.zoom}×${r.lens ? ` (${r.lens.zoom < 0.9 ? 'ultrawide' : r.lens.zoom <= 1.2 ? 'main' : 'telephoto'} lens)` : ''}, `
      + `digital crop ${r.digitalCrop}×${saved.focus !== undefined ? `, focus fixed at ${saved.focus} D (${cmOf(saved.focus)} cm)` : ''}.`,
    ...r.notes.map((n) => `  ! ${n}`), 'Check it with: agent-eye snapshot --out look.jpg'].join('\n'));
  });
}

async function cmdFocus(flags, what = 'scan') {
  const { path, profile } = requireConfig(flags);
  const region = regionFlag(flags, profile);
  if (what === 'auto') {
    const saved = saveChanges(path, profile.name, { focus: null, ...(region && { focusRegion: region }) });
    return print(flags, { ok: true, profile: profile.name, saved }, `Profile "${profile.name}": continuous autofocus${saved.focusRegion ? ' on the focus area' : ''}.`);
  }
  if (what !== 'scan') {
    const d = Number(what);
    if (!Number.isFinite(d) || d < 0) throw new UserError(`focus takes scan, auto or a distance in diopters (got "${what}").`, { code: 2 });
    const saved = saveChanges(path, profile.name, { focus: d, ...(region && { focusRegion: region }) });
    return print(flags, { ok: true, profile: profile.name, saved }, `Profile "${profile.name}": focus fixed at ${d} D (${cmOf(d) ?? 'infinity'}${d > 0 ? ' cm' : ''}).`);
  }
  await withPhone(flags, async ({ caps, session }) => {
    if (!caps.focusRange) throw new UserError('This camera has no manual focus.', { code: 2 });
    const c = profile.crop, full = !c || (c.x === 0 && c.y === 0 && c.w === 1 && c.h === 1);
    const area = region ?? profile.focusRegion ?? (full ? null : c);
    const scan = await session.control.scan(area && caps.afRegions ? viewToCamera(area, profile.rotate ?? 0) : null);
    if (!scan) throw new UserError('Autofocus did not finish.', { code: 3 });
    const focus = Math.round(scan.focus * 100) / 100;
    const saved = saveChanges(path, profile.name, { focus, ...(region && caps.afRegions && { focusRegion: region }) });
    print(flags, { ok: true, profile: profile.name, focus, distanceCm: cmOf(focus), sure: scan.ok, saved },
      `Profile "${profile.name}": focus fixed at ${focus} D (${cmOf(focus)} cm)${scan.ok ? '' : '. Autofocus was not sure: check with a snapshot.'}`);
  });
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
  const tailSec = numFlag(flags, 'tail', (v) => v >= 0 && v <= 600, 'a number of seconds between 0 and 600') ?? 0;
  // Frames reach the Mac a little after they are captured, so the last moments before `stop` are never in the file.
  // --tail keeps recording that much longer; Ctrl-C during the wait stops right away.
  if (tailSec && (await recorderStatus(statePath(path))).running) {
    const abort = new AbortController();
    abortOnSignals(abort);
    await new Promise((r) => { const t = setTimeout(r, tailSec * 1000); abort.signal.addEventListener('abort', () => { clearTimeout(t); r(); }); });
  }
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
      case 'configure': return flags.set !== undefined || flags.update !== undefined ? await cmdConfigureJson(flags) : await cmdWeb(flags, 'configure');
      case 'frame': return await cmdFrame(flags);
      case 'focus': return await cmdFocus(flags, parsed.rest[0]);
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
