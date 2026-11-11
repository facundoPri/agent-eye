import test from 'node:test';
import assert from 'node:assert/strict';
import { cameraLabel, groupLenses, parseAdbDevices, parseAndroidCameras, parseAvfoundationDevices, parseAvfoundationModes } from '../src/devices.js';
import { androidProblems } from '../src/validate.js';

const CAMERAS = `[server] INFO: List of cameras:
    --camera-id=0    (back, 4096x3072, fps={10, 15, 30, 60}, zoom-range=[1, 10], focus-range=[0.0, 10.0], locks=ae+awb)
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

test('parses manual focus range and 3A locks; cameras without them get none', () => {
  const [back, front] = parseAndroidCameras(CAMERAS);
  assert.deepEqual(back.focusRange, [0, 10]);
  assert.deepEqual(back.locks, ['ae', 'awb']);
  assert.equal(front.focusRange, null);
  assert.deepEqual(front.locks, []);
});

test('validation checks focus and locks against the camera', () => {
  const [back, front] = parseAndroidCameras(CAMERAS);
  const p = { width: 1920, height: 1080, fps: 30, zoom: 1, focus: 4, exposureLock: true, whiteBalanceLock: true };
  assert.deepEqual(androidProblems(p, back), []);
  assert.match(androidProblems({ ...p, focus: 12 }, back)[0], /closer than this camera can focus .*nearest 10 cm/);
  const f = androidProblems(p, front);
  assert.match(f[0], /no manual focus/); assert.match(f[1], /cannot lock exposure/); assert.match(f[2], /cannot lock white balance/);
});

test('a hidden logical camera: its lenses, AF regions, and no slow motion it cannot do', () => {
  const [cam] = parseAndroidCameras(`    --camera-id=4    (back, 4096x3072, fps={10, 30, 60}, zoom-range=[0.5, 10], focus-range=[0.0, 10.0], af-regions, hidden, lenses=[0:1.0:10.0, 2:0.61:40.0, 3:2.16:2.0], locks=ae+awb)
        - 1920x1080
      High speed capture (--camera-high-speed):
        - 1920x1080 (fps={120, 240})
`);
  assert.equal(cam.hidden, true); assert.equal(cam.afRegions, true);
  assert.deepEqual(cam.lenses, [{ id: '0', zoom: 1, nearest: 10, px: 0 }, { id: '2', zoom: 0.61, nearest: 40, px: 0 }, { id: '3', zoom: 2.16, nearest: 2, px: 0 }]);
  assert.deepEqual(cam.highSpeed, []);
  assert.match(androidProblems({ width: 1920, height: 1080, fps: 240, zoom: 1 }, cam)[0], /does not support 240/);
  assert.match(androidProblems({ width: 1920, height: 1080, fps: 30, zoom: 1, focusRegion: { x: 0, y: 0, w: 1, h: 1 } }, { ...cam, afRegions: false })[0], /cannot focus on a region/);
});

const PHONE = `    --camera-id=0    (back, 4096x3072, fps={30, 60}, zoom-range=[1, 10], focus-range=[0.0, 10.0], af-regions, lens-of=4, locks=ae+awb)
        - 1920x1080
      High speed capture (--camera-high-speed):
        - 1920x1080 (fps={120, 240})
    --camera-id=1    (front, 4576x3296, fps={30}, zoom-range=[1, 10], locks=ae+awb)
        - 1920x1080
    --camera-id=2    (back, 4080x3072, fps={30, 60}, zoom-range=[1, 10], focus-range=[0.0, 40.0], af-regions, hidden, lens-of=4, locks=ae+awb)
        - 1920x1080
    --camera-id=3    (back, 4032x3024, fps={30, 60}, zoom-range=[1, 10], focus-range=[0.0, 2.0], af-regions, hidden, lens-of=4, locks=ae+awb)
        - 1920x1080
    --camera-id=4    (back, 4096x3072, fps={30, 60}, zoom-range=[0.5, 10], focus-range=[0.0, 10.0], af-regions, hidden, lenses=[0:1.0:10.0:4096, 2:0.61:40.0:4080, 3:2.16:2.0:4032], locks=ae+awb)
        - 1920x1080
`;

test('lenses are numbered by zoom and every camera of the group knows them and which one it is', () => {
  const cams = groupLenses(parseAndroidCameras(PHONE));
  const byId = Object.fromEntries(cams.map((c) => [c.id, c]));
  assert.deepEqual(byId[4].lenses.map((l) => [l.n, l.id, l.kind]), [[1, '2', 'ultrawide'], [2, '0', 'main'], [3, '3', 'telephoto']]);
  assert.equal(byId[4].lensId, null);
  assert.equal(byId[3].lensId, '3'); assert.equal(byId[0].lensId, '0');
  assert.equal(byId[1].lenses, null);
  assert.deepEqual(cams.map(cameraLabel), ['back, lens 2 · main 1×', 'front', 'back, lens 1 · ultrawide 0.61×', 'back, lens 3 · telephoto 2.16×', 'back, all lenses (automatic)']);
  assert.deepEqual(byId[0].highSpeed.map((h) => h.size), ['1920x1080'], 'the listed main camera keeps its slow motion');
});
