import test from 'node:test';
import assert from 'node:assert/strict';
import { androidServerOptions, canStreamCopy, cropFilter, inputArgs, previewOutputArgs, recordOutputArgs, rotateFilters } from '../src/ffargs.js';

const android = { source: 'android:ABC/0', width: 1920, height: 1080, fps: 60, zoom: 1, crop: { x: 0, y: 0, w: 1, h: 1 }, rotate: 0 };
const mac = { ...android, source: 'mac:Cam', fps: 30 };

test('full frame Android recordings are stream-copied', () => {
  assert.equal(canStreamCopy(android), true);
  assert.deepEqual(recordOutputArgs(android, 'o.mp4').slice(-3), ['-c:v', 'copy', 'o.mp4']);
});

test('crop or rotate forces a re-encode; Mac always encodes', () => {
  assert.equal(canStreamCopy({ ...android, rotate: 90 }), false);
  assert.equal(canStreamCopy({ ...android, crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } }), false);
  assert.equal(canStreamCopy(mac), false);
  assert.ok(recordOutputArgs(mac, 'o.mp4').includes('libx264'));
});

test('crop filter keeps even dimensions', () => {
  const [f] = cropFilter({ x: 0.25, y: 0.1, w: 0.5, h: 0.5 });
  assert.match(f, /^crop=w=trunc\(iw\*0.5\/2\)\*2:h=trunc\(ih\*0.5\/2\)\*2:x=trunc\(iw\*0.25\/2\)\*2:y=trunc\(ih\*0.1\/2\)\*2$/);
  assert.deepEqual(cropFilter({ x: 0, y: 0, w: 1, h: 1 }), []);
});

test('rotation filters', () => {
  assert.deepEqual(rotateFilters(0), []);
  assert.deepEqual(rotateFilters(90), ['transpose=1']);
  assert.deepEqual(rotateFilters(180), ['hflip', 'vflip']);
  assert.deepEqual(rotateFilters(270), ['transpose=2']);
});

test('preview applies rotation but leaves crop to the browser', () => {
  const args = previewOutputArgs({ ...android, rotate: 90, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } });
  const vf = args[args.indexOf('-vf') + 1];
  assert.equal(vf, 'transpose=1,fps=15,scale=960:-2');
});

test('stills keep full resolution and apply the crop', () => {
  const args = previewOutputArgs({ ...android, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } }, { width: 0, fps: 5, applyCrop: true });
  assert.ok(!args.join(' ').includes('scale='));
  assert.match(args[args.indexOf('-vf') + 1], /^crop=.*,fps=5$/);
});

test('Mac input pins size and rate and drops audio', () => {
  const args = inputArgs(mac, { macIndex: 1 });
  assert.deepEqual(args.slice(-2), ['-i', '1:none']);
  assert.ok(args.includes('1920x1080') && args.includes('30'));
  assert.throws(() => inputArgs(mac), /macIndex/);
});

test('slow motion options: high speed above 60 fps, encoder rate above 120', () => {
  assert.ok(!androidServerOptions(android, 0).some((o) => o.startsWith('camera_high_speed')));
  const hs120 = androidServerOptions({ ...android, fps: 120 }, 0);
  assert.ok(hs120.includes('camera_high_speed=true') && hs120.includes('max_fps=120'));
  assert.ok(!hs120.some((o) => o.startsWith('video_codec_options')));
  const hs240 = androidServerOptions({ ...android, fps: 240 }, 0);
  assert.ok(hs240.includes('video_codec_options=operating-rate:int=480,priority:int=0'));
  assert.ok(hs240.includes('video_bit_rate=40000000'));
});

test('native zoom is sent only above 1x; bitrate override wins', () => {
  assert.ok(!androidServerOptions(android, 0).some((o) => o.startsWith('camera_zoom')));
  const o = androidServerOptions({ ...android, zoom: 2.5, bitrate: 12 }, 1);
  assert.ok(o.includes('camera_zoom=2.5') && o.includes('camera_id=1') && o.includes('video_bit_rate=12000000'));
});

test('Android input keeps the phone capture timestamps, not arrival times', () => {
  const opts = androidServerOptions(android, 0);
  assert.ok(opts.includes('send_frame_meta=true'));
  assert.ok(!opts.some((o) => o.startsWith('raw_stream')), 'raw_stream would turn the frame headers off');
  const args = inputArgs(android);
  assert.equal(args[args.indexOf('-f') + 1], 'mpegts');
  assert.ok(!args.includes('-use_wallclock_as_timestamps'));
});
