// The phone's framed H.264 (scrcpy packet headers) into MPEG-TS that keeps the capture timestamps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScrcpyPackets, TsMuxer, scrcpyPacket, scrcpyToTs } from '../src/mpegts.js';
import { findBin } from '../src/util.js';

test('scrcpy packets are split across arbitrary chunk boundaries, with their flags', () => {
  const got = [];
  const p = new ScrcpyPackets((x) => got.push({ ...x, data: [...x.data] }));
  const session = Buffer.alloc(12); session[0] = 0x80; // header-only stream metadata: skipped
  const all = Buffer.concat([session, scrcpyPacket(Buffer.from([1, 2]), { config: true }),
    scrcpyPacket(Buffer.from([3]), { ptsUs: 5_000_000_000, key: true }), scrcpyPacket(Buffer.from([4, 5, 6]), { ptsUs: 5_000_016_667 })]);
  for (let i = 0; i < all.length; i += 5) p.push(all.subarray(i, i + 5));
  assert.deepEqual(got, [
    { ptsUs: 0, config: true, key: false, data: [1, 2] },
    { ptsUs: 5_000_000_000, config: false, key: true, data: [3] },
    { ptsUs: 5_000_016_667, config: false, key: false, data: [4, 5, 6] },
  ]);
});

test('a corrupt packet size is an error, not a huge allocation', () => {
  const bad = Buffer.alloc(12); bad.writeUInt32BE(0xffffffff, 8);
  assert.throws(() => new ScrcpyPackets(() => {}).push(bad), /Malformed/);
});

/** Parse TS packets back: per-PID continuity and each PES's PTS. */
function readTs(buf) {
  assert.equal(buf.length % 188, 0);
  const cc = new Map(), pts = [];
  for (let i = 0; i < buf.length; i += 188) {
    const p = buf.subarray(i, i + 188);
    assert.equal(p[0], 0x47);
    const pid = ((p[1] & 0x1f) << 8) | p[2];
    const c = p[3] & 15;
    if (cc.has(pid)) assert.equal(c, (cc.get(pid) + 1) & 15, `continuity on PID ${pid}`);
    cc.set(pid, c);
    if (pid !== 0x100 || !(p[1] & 0x40)) continue;
    const off = p[3] & 0x20 ? 5 + p[4] : 4;
    assert.deepEqual([...p.subarray(off, off + 4)], [0, 0, 1, 0xe0]);
    const h = p.subarray(off + 9);
    pts.push(((h[0] >> 1) & 7) * 2 ** 30 + (h.readUInt16BE(1) >> 1) * 2 ** 15 + (h.readUInt16BE(3) >> 1));
  }
  return pts;
}

test('TS output keeps continuity counters and the PTS of every frame, for any payload size', () => {
  const mux = new TsMuxer();
  const sizes = [0, 1, 169, 170, 171, 183, 184, 352, 353, 5000];
  const ticks = sizes.map((_, i) => 2 ** 32 + i * 1500); // above 32 bits, to exercise the 33-bit fields
  const buf = Buffer.concat(sizes.map((n, i) => mux.frame(Buffer.alloc(n, 9), ticks[i], i === 0)));
  assert.deepEqual(readTs(buf), ticks);
});

test('the stream starts at 0 and keeps the phone spacing; config rides with the next frame', async () => {
  const ts = scrcpyToTs();
  const out = [];
  ts.on('data', (d) => out.push(d));
  ts.write(scrcpyPacket(Buffer.from('SPS'), { config: true }));
  for (const us of [7_000_000, 7_016_667, 7_050_000]) ts.write(scrcpyPacket(Buffer.alloc(100, 1), { ptsUs: us, key: us === 7_000_000 }));
  ts.end();
  await new Promise((r) => ts.on('end', r));
  const buf = Buffer.concat(out);
  assert.deepEqual(readTs(buf), [0, 1500, 4500]);
  assert.ok(buf.includes(Buffer.from([0, 0, 1, 0xe0])) && buf.indexOf('SPS') < buf.indexOf(Buffer.alloc(100, 1)));
});

// With a real ffmpeg (skipped without one): a real H.264 stream through the muxer keeps exact timestamps in the MP4.
const ffmpeg = findBin('ffmpeg'), ffprobe = findBin('ffprobe');
test('real ffmpeg reads the TS and the MP4 keeps capture timing, including a dropped frame', { skip: !(ffmpeg && ffprobe) && 'needs ffmpeg' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-eye-ts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  try {
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=60', '-frames:v', '20', '-c:v', 'libx264',
      '-bf', '0', '-g', '10', '-x264-params', 'aud=1', '-f', 'h264', join(dir, 'in.h264')]);
  } catch { return t.skip('ffmpeg has no libx264'); }
  const es = readFileSync(join(dir, 'in.h264'));
  const starts = [];
  for (let i = es.indexOf(Buffer.from([0, 0, 0, 1, 9])); i >= 0; i = es.indexOf(Buffer.from([0, 0, 0, 1, 9]), i + 1)) starts.push(i);
  const ts = scrcpyToTs();
  const chunks = [];
  ts.on('data', (d) => chunks.push(d));
  let us = 1_000_000_000;
  starts.forEach((s, i) => {
    if (i === 8) us += 16_667; // the camera dropped one frame here
    ts.write(scrcpyPacket(es.subarray(s, starts[i + 1]), { ptsUs: us, key: i % 10 === 0 }));
    us += 16_667;
  });
  ts.end();
  await new Promise((r) => ts.on('end', r));
  writeFileSync(join(dir, 'in.ts'), Buffer.concat(chunks));
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'mpegts', '-i', join(dir, 'in.ts'), '-c:v', 'copy', '-fps_mode', 'passthrough', join(dir, 'out.mp4')]);
  const pts = execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', join(dir, 'out.mp4')], { encoding: 'utf8' })
    .trim().split('\n').map(Number).sort((a, b) => a - b);
  const steps = pts.slice(1).map((v, i) => Math.round((v - pts[i]) * 1e5) / 100);
  assert.equal(pts.length, 20);
  assert.deepEqual(steps.filter((d) => Math.abs(d - 16.67) > 0.02), [33.33]);
});
