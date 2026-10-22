// Camera session and recording lifecycle against fake tools (see helpers/fakes.js). No hardware.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ANDROID_PROFILE, setupFakes, waitFor, withEnv } from './helpers/fakes.js';
import { startSession } from '../src/session.js';
import { recordToFile, recordingProblem } from '../src/capture.js';
import { previewOutputArgs } from '../src/ffargs.js';

let fakes;
test.before(async () => { fakes = await setupFakes(); });
test.after(() => fakes.close());
test.beforeEach(() => { fakes.ffmpeg({}); fakes.adb({}); fakes.tunnel.mode = 'stream'; });
test.afterEach(async () => {
  await waitFor(() => fakes.live().length === 0, 3000, 'fake processes to exit').catch(() => {});
  assert.deepEqual(fakes.live(), [], 'a test left processes running');
});

const inFakes = (fn) => withEnv(fakes.env, fn);
const out = (name) => join(fakes.dir, name);

test('a failure while preparing the phone stops ffmpeg (adb push fails)', () => inFakes(async () => {
  fakes.adb({ pushFail: true });
  await assert.rejects(recordToFile(ANDROID_PROFILE, out('a.mp4')), (e) => e.exitCode === 3 && /push/.test(e.message));
}));

test('a failure creating the tunnel stops ffmpeg (adb forward fails)', () => inFakes(async () => {
  fakes.adb({ forwardFail: true });
  await assert.rejects(recordToFile(ANDROID_PROFILE, out('b.mp4')), /adb forward failed/);
}));

test('a tunnel that connects but stays silent times out and cleans up', { timeout: 10000 }, () => inFakes(async () => {
  fakes.tunnel.mode = 'silent';
  const t0 = Date.now();
  await assert.rejects(startSession(ANDROID_PROFILE, ['-f', 'null', '-'], { startTimeoutMs: 700 }), /sent nothing/);
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
}));

test('aborting while the phone camera starts cancels the recording promptly', { timeout: 10000 }, () => inFakes(async () => {
  fakes.tunnel.mode = 'delay'; fakes.tunnel.delayMs = 5000;
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 300);
  const t0 = Date.now();
  await assert.rejects(recordToFile(ANDROID_PROFILE, out('c.mp4'), { signal: abort.signal }), /Stopped before the camera started/);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
}));

test('a signal that was already aborted never starts a recording', { timeout: 10000 }, () => inFakes(async () => {
  const abort = new AbortController();
  abort.abort();
  const before = fakes.started('ffmpeg');
  await assert.rejects(recordToFile(ANDROID_PROFILE, out('d.mp4'), { signal: abort.signal }), /Stopped before/);
  assert.equal(fakes.started('ffmpeg'), before);
}));

test('aborting while a Mac camera warms up stops it and records nothing', { skip: process.platform !== 'darwin', timeout: 10000 }, () => inFakes(async () => {
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 300);
  const mac = { source: 'mac:Fake Camera', width: 1280, height: 720, fps: 30 };
  await assert.rejects(recordToFile(mac, out('m.mp4'), { signal: abort.signal }), /Stopped before/);
}));

test('a timed recording finishes, is probed and gets a sidecar summary', () => inFakes(async () => {
  const s = await recordToFile(ANDROID_PROFILE, out('e.mp4'), { durationSec: 0.4 });
  assert.equal(s.frames, 60);
  assert.deepEqual(s.warnings, []);
  assert.ok(existsSync(out('e.json')));
}));

test('the phone stream reaches ffmpeg as MPEG-TS carrying the phone timestamps', () => inFakes(async () => {
  await recordToFile(ANDROID_PROFILE, out('ts.mp4'), { durationSec: 0.4 });
  assert.match(readFileSync(out('ts.mp4'), 'utf8'), /^FAKEVIDEO [1-9]\d* ts=ok$/);
}));

test('the summary warns when frame timestamps are bunched (arrival times, not capture times)', () => inFakes(async () => {
  let t = 0; // 60 fps on average, but in bursts of 5 / 16.7 / 28 ms like video7.mp4
  fakes.ffprobe({ ptsTimes: Array.from({ length: 61 }, (_, i) => (t += [0.0167, 0.005, 0.028][i % 3])) });
  try {
    const s = await recordToFile(ANDROID_PROFILE, out('jit.mp4'), { durationSec: 0.3 });
    assert.equal(s.frameIntervalMs.median, 16.7);
    assert.equal(s.frameIntervalMs.irregular, 40);
    assert.match(s.warnings.join('\n'), /timestamps are irregular: 40 of 60 intervals/);
  } finally { fakes.ffprobe({}); }
}));

test('stopping early ends a long --duration recording without waiting for its timer', { timeout: 10000 }, () => inFakes(async () => {
  const abort = new AbortController();
  const t0 = Date.now();
  const p = recordToFile(ANDROID_PROFILE, out('f.mp4'), { durationSec: 3600, signal: abort.signal, onStarted: () => setTimeout(() => abort.abort(), 200) });
  const s = await p;
  assert.equal(s.frames, 60);
  assert.ok(Date.now() - t0 < 3000);
}));

test('ffmpeg failing to write the trailer is a failed recording, not a summary', () => inFakes(async () => {
  fakes.ffmpeg({ exitCode: 1, output: 'partial', stderr: 'Error writing trailer: No space left on device' });
  await assert.rejects(recordToFile(ANDROID_PROFILE, out('g.mp4'), { durationSec: 0.3 }),
    (e) => e.exitCode === 3 && /Recording failed/.test(e.message) && /No space left/.test(e.message));
  assert.equal(existsSync(out('g.json')), false);
}));

test('an unreadable file is rejected even when ffmpeg exits 0', () => inFakes(async () => {
  fakes.ffmpeg({ output: 'partial' });
  await assert.rejects(recordToFile(ANDROID_PROFILE, out('h.mp4'), { durationSec: 0.3 }), /not a readable video/);
}));

test('a stale summary from an earlier take is removed when the new one fails', () => inFakes(async () => {
  await recordToFile(ANDROID_PROFILE, out('i.mp4'), { durationSec: 0.2 });
  fakes.ffmpeg({ exitCode: 1, output: 'partial' });
  await assert.rejects(recordToFile(ANDROID_PROFILE, out('i.mp4'), { durationSec: 0.2 }));
  assert.equal(existsSync(out('i.json')), false);
}));

test('recordingProblem: what counts as a finished file', () => {
  const ok = { frames: 10 };
  assert.equal(recordingProblem({ code: 0 }, ok), null);
  assert.equal(recordingProblem({ code: 255 }, ok), null, 'ffmpeg finishing after Ctrl-C');
  assert.equal(recordingProblem({ code: 0 }, null), null, 'no ffprobe: accepted with a warning');
  assert.equal(recordingProblem({ code: 0 }, { unchecked: 'ffprobe took longer than 3 minutes' }), null, 'slow ffprobe: accepted with a warning');
  assert.match(recordingProblem({ code: null, signal: 'SIGKILL', killed: true }, ok), /killed/);
  assert.match(recordingProblem({ code: 1 }, ok), /code 1/);
  assert.match(recordingProblem({ code: 0 }, { unreadable: 'moov atom not found' }), /moov/);
  assert.match(recordingProblem({ code: 0 }, { frames: 0 }), /no video frames/);
});

test('a slow ffmpeg holds the phone stream back instead of buffering it in memory', () => inFakes(async () => {
  fakes.tunnel.mode = 'flood'; fakes.tunnel.flushed = 0;
  fakes.ffmpeg({ stallMs: 1500 });
  const session = await startSession(ANDROID_PROFILE, ['-c:v', 'copy', out('j.mp4')]);
  await new Promise((r) => setTimeout(r, 1000));
  // Loopback moves gigabytes a second; with backpressure only the socket and pipe buffers fill.
  assert.ok(fakes.tunnel.flushed < 64 * 2 ** 20, `${fakes.tunnel.flushed} bytes left the phone while ffmpeg read nothing`);
  const t0 = Date.now();
  const res = await session.stop();
  assert.equal(res.code, 0);
  assert.ok(Date.now() - t0 < 5000);
}));

test('preview sessions deliver frames on stdout and stop cleanly', () => inFakes(async () => {
  let bytes = 0;
  const session = await startSession(ANDROID_PROFILE, previewOutputArgs(ANDROID_PROFILE), { onStdout: (d) => { bytes += d.length; } });
  await waitFor(() => bytes > 0, 2000, 'frames');
  assert.equal((await session.stop()).code, 0);
}));
