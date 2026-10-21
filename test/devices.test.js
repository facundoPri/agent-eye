import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAdbDevices, parseAndroidCameras, parseAvfoundationDevices, parseAvfoundationModes } from '../src/devices.js';
import { androidProblems } from '../src/validate.js';

const CAMERAS = `[server] INFO: List of cameras:
    --camera-id=0    (back, 4096x3072, fps={10, 15, 30, 60}, zoom-range=[1, 10])
        - 4096x3072
        - 1920x1080
        - 1280x720
      High speed capture (--camera-high-speed):
        - 1280x720 (fps={120, 240})
        - 1920x1080 (fps={120, 240})
    --camera-id=1    (front, 4576x3296, fps={15, 30})
        - 1920x1080
`;

test('parses Mac cameras and ignores screens', () => {
  const text = `[AVFoundation indev @ 0x1] AVFoundation video devices:
[AVFoundation indev @ 0x1] [0] MacBook Air Camera
[AVFoundation indev @ 0x1] [1] Capture screen 0
[AVFoundation indev @ 0x1] AVFoundation audio devices:
[AVFoundation indev @ 0x1] [0] Microphone`;
  assert.deepEqual(parseAvfoundationDevices(text), [{ id: 'mac:MacBook Air Camera', kind: 'mac', index: 0, name: 'MacBook Air Camera' }]);
});

test('parses avfoundation supported modes', () => {
  const m = parseAvfoundationModes('[x] 1280x720@[1.000000 30.000000]fps\n[x] 1920x1080@[1.000000 60.000000]fps\n[x] 1280x720@[1.000000 15.000000]fps');
  assert.deepEqual(m, [{ size: '1280x720', maxFps: 30 }, { size: '1920x1080', maxFps: 60 }]);
});

test('parses adb states', () => {
  const t = 'List of devices attached\nZY22 device usb:1 product:rtwo model:motorola_edge_40_pro device:rtwo\nAAAA unauthorized usb:2\n';
  assert.deepEqual(parseAdbDevices(t), [
    { serial: 'ZY22', state: 'device', model: 'motorola edge 40 pro' },
    { serial: 'AAAA', state: 'unauthorized', model: 'AAAA' }]);
});

test('parses phone cameras with slow motion and optional zoom range', () => {
  const [back, front] = parseAndroidCameras(CAMERAS);
  assert.deepEqual(back.zoomRange, [1, 10]);
  assert.deepEqual(back.sizes, ['4096x3072', '1920x1080', '1280x720']);
  assert.deepEqual(back.highSpeed, [{ size: '1280x720', fps: [120, 240] }, { size: '1920x1080', fps: [120, 240] }]);
  assert.deepEqual(front.zoomRange, [1, 1]);
  assert.deepEqual(front.sizes, ['1920x1080']);
});

test('validation accepts slow motion sizes and rejects unsupported rates', () => {
  const [back] = parseAndroidCameras(CAMERAS);
  const p = { width: 1920, height: 1080, fps: 240, zoom: 1 };
  assert.deepEqual(androidProblems(p, back), []);
  assert.deepEqual(androidProblems({ ...p, fps: 60 }, back), []);
  assert.match(androidProblems({ ...p, fps: 45 }, back)[0], /Allowed: 10, 15, 30, 60, 120, 240/);
  assert.match(androidProblems({ ...p, width: 1000, height: 1000 }, back)[0], /not a supported size/);
  assert.match(androidProblems({ ...p, zoom: 12 }, back)[0], /range 1-10/);
  assert.match(androidProblems({ ...p, width: 4096, height: 3072, fps: 120 }, back)[0], /does not support 120/);
});
