// The CLI as a process (record, start, stop, status) against fake tools (see helpers/fakes.js). No hardware.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANDROID_PROFILE, setupFakes, waitFor } from './helpers/fakes.js';
import { summaryText } from '../src/cli.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-eye.js');
let fakes;
test.before(async () => { fakes = await setupFakes(); });
test.after(() => fakes.close());
test.beforeEach(() => { fakes.ffmpeg({}); fakes.adb({}); fakes.tunnel.mode = 'stream'; });
test.afterEach(async () => {
  await waitFor(() => fakes.live().length === 0, 5000, 'fake processes to exit').catch(() => {});
  assert.deepEqual(fakes.live(), [], 'a test left processes running');
});

/** Run the CLI; resolves { code, json, stderr, ms }. `child` is exposed for signalling. */
function cli(cwd, args, { group = false } = {}) {
  const t0 = Date.now();
  // group: own process group, so a signal can reach the CLI and its ffmpeg together, as Ctrl-C in a terminal does.
  const child = spawn(process.execPath, [BIN, ...args, '--json'], { cwd, env: fakes.env, detached: group });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const done = new Promise((resolve) => child.on('close', (code) => {
    let json = null;
    try { json = JSON.parse(stdout); } catch { /* not JSON */ }
    resolve({ code, json, stdout, stderr, ms: Date.now() - t0 });
  }));
  return Object.assign(done, { child });
}

const stateFile = (root) => join(root, '.agent-eye', 'recording.json');

test('invalid --duration is refused before any camera opens', { timeout: 20000 }, async () => {
  const root = fakes.project();
  const before = fakes.started('ffmpeg');
  for (const d of ['abc', '30s', '0', '-5', '']) {
    const r = await cli(root, ['record', '--out', join(root, 'x.mp4'), `--duration=${d}`]);
    assert.equal(r.code, 2, `--duration=${d}: ${r.stdout}`);
    assert.match(r.json.error, /--duration/);
  }
  assert.equal(fakes.started('ffmpeg'), before);
});

test('Ctrl-C ends `record --duration 3600` right away with a summary', { timeout: 20000 }, async () => {
  const root = fakes.project();
  const before = fakes.started('adbserver');
  const run = cli(root, ['record', '--out', join(root, 'long.mp4'), '--duration', '3600']);
  await waitFor(() => fakes.started('adbserver') > before, 5000, 'the camera to start');
  await new Promise((r) => setTimeout(r, 300));
  run.child.kill('SIGINT');
  const r = await run;
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.frames, 60);
  assert.ok(r.ms < 6000, `exited after ${r.ms} ms`);
});

test('Ctrl-C while the phone camera is still starting cancels instead of recording', { timeout: 20000 }, async () => {
  const root = fakes.project();
  fakes.tunnel.mode = 'delay'; fakes.tunnel.delayMs = 4000;
  const before = fakes.started('adbserver');
  const run = cli(root, ['record', '--out', join(root, 'never.mp4')]);
  await waitFor(() => fakes.started('adbserver') > before, 5000, 'the camera server to start');
  run.child.kill('SIGINT');
  const r = await run;
  assert.equal(r.code, 1);
  assert.match(r.json.error, /Stopped before the camera started/);
  assert.ok(r.ms < 3500, `exited after ${r.ms} ms`);
});

test('two concurrent `start`s: one records, the other is refused; `stop` returns the summary', { timeout: 20000 }, async () => {
  const root = fakes.project();
  const [a, b] = await Promise.all([
    cli(root, ['start', '--out', join(root, 'a.mp4')]),
    cli(root, ['start', '--out', join(root, 'b.mp4')]),
  ]);
  const ok = [a, b].filter((r) => r.code === 0);
  const refused = [a, b].filter((r) => r.code !== 0);
  assert.equal(ok.length, 1, a.stdout + b.stdout);
  assert.match(refused[0].json.error, /already running/);
  assert.equal(fakes.live().filter((p) => p.name === 'ffmpeg').length, 1);

  const st = await cli(root, ['status']);
  assert.equal(st.json.running, true);
  assert.equal(st.json.out, ok[0].json.out);

  const stop = await cli(root, ['stop']);
  assert.equal(stop.code, 0, stop.stdout);
  assert.equal(stop.json.file, ok[0].json.out);
  assert.equal(stop.json.frames, 60);
  assert.equal(existsSync(stateFile(root)), false);
  assert.equal((await cli(root, ['status'])).json.running, false);
});

test('`stop` reports a recording whose file was not finalised as a failure', { timeout: 20000 }, async () => {
  const root = fakes.project();
  fakes.ffmpeg({ exitCode: 1, output: 'partial', stderr: 'Error writing trailer: No space left on device' });
  assert.equal((await cli(root, ['start', '--out', join(root, 'bad.mp4')])).code, 0);
  const stop = await cli(root, ['stop']);
  assert.equal(stop.code, 3, stop.stdout);
  assert.match(stop.json.error, /Recording failed.*No space left/s);
  assert.equal(existsSync(join(root, 'bad.json')), false);
});

test('`stop` while the background recorder is still starting cancels it', { timeout: 20000 }, async () => {
  const root = fakes.project();
  fakes.tunnel.mode = 'delay'; fakes.tunnel.delayMs = 4000;
  const start = cli(root, ['start', '--out', join(root, 'early.mp4')]);
  await waitFor(() => existsSync(stateFile(root)), 5000, 'the claim');
  const stop = await cli(root, ['stop']);
  assert.equal(stop.code, 1, stop.stdout);
  assert.match(stop.json.error, /Stopped before the camera started/);
  const s = await start;
  assert.notEqual(s.code, 0);
  assert.ok(stop.ms < 4000, `stop took ${stop.ms} ms`);
});

test('a stale state whose pid now belongs to another process is never signalled', { timeout: 20000 }, async () => {
  const root = fakes.project();
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  try {
    const free = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
    writeFileSync(stateFile(root), JSON.stringify({ id: 'old', pid: other.pid, port: free, out: join(root, 'old.mp4'), createdAt: Date.now() - 3600e3 }));
    const st = await cli(root, ['status']);
    assert.equal(st.json.running, false);
    const stop = await cli(root, ['stop']);
    assert.equal(stop.code, 1);
    assert.match(stop.json.error, /without reporting a result/);
    assert.equal(other.exitCode, null);
    assert.doesNotThrow(() => process.kill(other.pid, 0), 'the unrelated process must still be alive');
    assert.equal(existsSync(stateFile(root)), false, 'the stale state is cleared');
    // and a new recording can start
    assert.equal((await cli(root, ['start', '--out', join(root, 'new.mp4')])).code, 0);
    assert.equal((await cli(root, ['stop'])).code, 0);
  } finally { other.kill(); }
});

test('summary text survives missing measurements (no ffprobe)', () => {
  assert.equal(summaryText({ file: '/v.mp4', warnings: ['ffprobe is not installed'] }), '/v.mp4\n  ! ffprobe is not installed');
});

test('Ctrl-C to the whole process group (ffmpeg exits 255 on its own) still gives a summary', { timeout: 20000 }, async () => {
  const root = fakes.project();
  const before = fakes.started('adbserver');
  const run = cli(root, ['record', '--out', join(root, 'group.mp4')], { group: true });
  await waitFor(() => fakes.started('adbserver') > before, 5000, 'the camera to start');
  await new Promise((r) => setTimeout(r, 300));
  process.kill(-run.child.pid, 'SIGINT');
  const r = await run;
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.frames, 60);
});

test('Ctrl-C on `start` while the recorder boots stops the detached worker too', { timeout: 20000 }, async () => {
  const root = fakes.project();
  fakes.tunnel.mode = 'delay'; fakes.tunnel.delayMs = 4000;
  const run = cli(root, ['start', '--out', join(root, 'cancelled.mp4')]);
  await waitFor(() => fakes.live().some((p) => p.name === 'worker'), 5000, 'the worker');
  run.child.kill('SIGINT');
  const r = await run;
  assert.equal(r.code, 1, r.stdout);
  await waitFor(() => fakes.live().length === 0, 5000, 'the worker and camera to stop');
  assert.equal(existsSync(stateFile(root)), false);
});

test('a `start` that cannot launch its worker releases its claim', { timeout: 20000 }, async () => {
  const root = fakes.project();
  mkdirSync(join(root, '.agent-eye', 'worker.log')); // the log cannot be opened
  const r = await cli(root, ['start', '--out', join(root, 'x.mp4')]);
  assert.notEqual(r.code, 0);
  assert.equal(existsSync(stateFile(root)), false);
  assert.equal((await cli(root, ['status'])).json.running, false);
});

test('`stop --tail` keeps recording that much longer; a bad --tail is refused', { timeout: 20000 }, async () => {
  const root = fakes.project();
  assert.equal((await cli(root, ['start', '--out', join(root, 't.mp4')])).code, 0);
  const bad = await cli(root, ['stop', '--tail', 'soon']);
  assert.equal(bad.code, 2);
  assert.match(bad.json.error, /--tail/);
  const stop = await cli(root, ['stop', '--tail', '1.5']);
  assert.equal(stop.code, 0, stop.stdout);
  assert.ok(stop.ms >= 1500, `stopped after ${stop.ms} ms`);
  assert.ok(stop.json.stoppedAtMs - stop.json.startedAtMs >= 1500);
});

const readConfig = (root) => JSON.parse(readFileSync(join(root, '.agent-eye', 'config.json'), 'utf8'));
const hs = JSON.stringify({ source: 'android:FAKE1/0', width: 1280, height: 720, fps: 15 });

test('`configure --set --profile X` creates X and leaves the default profile and selection alone', { timeout: 20000 }, async () => {
  const root = fakes.project();
  const before = readConfig(root);
  for (const flag of ['--profile', '--name']) {
    const name = `hs${flag.slice(2)}`;
    const r = await cli(root, ['configure', flag, name, '--set', hs]);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.created, true);
    const cfg = readConfig(root);
    assert.equal(cfg.profiles[name].fps, 15);
    assert.deepEqual(cfg.profiles.default, before.profiles.default, 'the human-confirmed profile is untouched');
    assert.equal(cfg.default, 'default', 'the default selection is untouched');
  }
});

test('`configure --set` without a name updates the current default; --default switches it', { timeout: 20000 }, async () => {
  const root = fakes.project();
  assert.equal((await cli(root, ['configure', '--name', 'hs', '--set', hs, '--default'])).json.default, 'hs');
  const r = await cli(root, ['configure', '--set', JSON.stringify({ source: 'android:FAKE1/0', width: 1920, height: 1080, fps: 60 })]);
  assert.equal(r.json.name, 'hs');
  const cfg = readConfig(root);
  assert.equal(cfg.profiles.hs.fps, 60);
  assert.equal(cfg.profiles.default.fps, 30, 'the profile that is no longer the default is not touched');
});

test('`configure --set` refuses --name and --profile that disagree', { timeout: 20000 }, async () => {
  const root = fakes.project();
  const r = await cli(root, ['configure', '--name', 'a', '--profile', 'b', '--set', hs]);
  assert.equal(r.code, 2);
  assert.match(r.json.error, /different profiles/);
  assert.deepEqual(Object.keys(readConfig(root).profiles), ['default']);
});

test('`configure --set` input mistakes are refused before the config is touched', { timeout: 20000 }, async () => {
  const root = fakes.project();
  const before = readFileSync(join(root, '.agent-eye', 'config.json'), 'utf8');
  for (const [args, why] of [
    [['--name', 'x', '--default=false', '--set', hs], /--default takes no value/],
    [['--set', JSON.stringify({ ...JSON.parse(hs), name: 5 })], /"name" .* must be a string/],
    [['--name', '--set', hs], /--name needs a value/],
  ]) {
    const r = await cli(root, ['configure', ...args]);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}`);
    assert.match(r.json.error, why);
  }
  assert.equal(readFileSync(join(root, '.agent-eye', 'config.json'), 'utf8'), before);
});

test('`configure --set` on an empty project makes the first profile the default', { timeout: 20000 }, async () => {
  const root = fakes.project();
  rmSync(join(root, '.agent-eye', 'config.json'));
  const r = await cli(root, ['configure', '--name', 'first', '--set', hs]);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(readConfig(root).default, 'first');
});

test('`configure --update` changes only the given fields; null removes one', { timeout: 20000 }, async () => {
  const root = fakes.project({ ...ANDROID_PROFILE, focus: 4 });
  const r = await cli(root, ['configure', '--update', JSON.stringify({ exposureLock: true, focus: null })]);
  assert.equal(r.code, 0, r.stdout);
  const p = readConfig(root).profiles.default;
  assert.equal(p.exposureLock, true); assert.equal('focus' in p, false); assert.equal(p.fps, ANDROID_PROFILE.fps);
});

test('`frame --region` and `focus` set zoom, crop and focus from the live phone camera', { timeout: 30000 }, async () => {
  const root = fakes.project({ source: 'android:FAKE1/4', width: 1920, height: 1080, fps: 30 });
  const f = await cli(root, ['frame', '--region', '0.45,0.44,0.1,0.12']);
  assert.equal(f.code, 0, f.stdout);
  assert.equal(f.json.lens.id, '0');
  assert.ok(f.json.saved.zoom < 2.2 && f.json.saved.focus === 4.25 && f.json.saved.crop.w < 1, JSON.stringify(f.json.saved));
  assert.match(f.json.notes.join(' '), /telephoto/);
  const scan = await cli(root, ['focus', 'scan', '--region', '0.2,0.2,0.6,0.6']);
  assert.equal(scan.code, 0, scan.stdout);
  assert.equal(scan.json.focus, 4.25); assert.ok(scan.json.saved.focusRegion);
  assert.equal('focus' in (await cli(root, ['focus', 'auto'])).json.saved, false);
  assert.equal((await cli(root, ['focus', '2.5'])).json.saved.focus, 2.5);
  assert.equal((await cli(root, ['frame', '--region', '0.5,0.5,0.6,0.6'])).code, 2, 'a region outside the picture is refused');
});

test('`frame` opens the camera again when the phone drops it while switching lenses', { timeout: 30000 }, async () => {
  rmSync(join(fakes.dir, 'dropped'), { force: true });
  fakes.adb({ dropOnce: true });
  const root = fakes.project({ source: 'android:FAKE1/4', width: 1920, height: 1080, fps: 30 });
  const f = await cli(root, ['frame', '--region', '0.45,0.44,0.1,0.12']);
  assert.equal(f.code, 0, f.stdout + f.stderr);
  assert.match(f.stderr, /closed the camera[\s\S]*Opening it again/);
  assert.ok(f.json.saved.zoom > 1);
});

test('`frame --lens` frames on a chosen lens, or on the one that shows the region with the most detail', { timeout: 40000 }, async () => {
  fakes.adb({ subjectFocus: 1 }); // 1 m away: every lens can focus on it
  const root = fakes.project({ source: 'android:FAKE1/4', width: 1920, height: 1080, fps: 30 });
  const plain = await cli(root, ['frame', '--region', '0.45,0.45,0.1,0.1']);
  assert.equal(plain.code, 0, plain.stdout);
  assert.equal(plain.json.bestLens, '3');
  assert.deepEqual(plain.json.lenses.map((l) => l.n).sort(), [1, 2, 3]);
  assert.equal(plain.json.lens.n, 3, 'the switching camera already zooms onto the telephoto');
  // From the main lens's own camera, best moves to the telephoto's.
  writeFileSync(join(root, '.agent-eye', 'config.json'), JSON.stringify({ version: 1, default: 'default',
    profiles: { default: { source: 'android:FAKE1/0', width: 1920, height: 1080, fps: 30 } } }));
  const best = await cli(root, ['frame', '--region', '0.45,0.45,0.1,0.1', '--lens', 'best']);
  assert.equal(best.code, 0, best.stdout);
  assert.equal(best.json.saved.source, 'android:FAKE1/3');
  assert.equal(best.json.lens.n, 3);
  const one = await cli(root, ['frame', '--region', '0.2,0.2,0.6,0.6', '--lens', '1']);
  assert.equal(one.code, 0, one.stdout);
  assert.equal(one.json.saved.source, 'android:FAKE1/2');
  const auto = await cli(root, ['frame', '--region', '0.2,0.2,0.6,0.6', '--lens', 'auto']);
  assert.equal(auto.json.saved.source, 'android:FAKE1/4');
  assert.equal((await cli(root, ['frame', '--region', '0.4,0.4,0.2,0.2', '--lens', '9'])).code, 2);
});
