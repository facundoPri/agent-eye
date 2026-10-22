// The CLI as a process (record, start, stop, status) against fake tools (see helpers/fakes.js). No hardware.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupFakes, waitFor } from './helpers/fakes.js';
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
