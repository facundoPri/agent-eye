import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { findBin, run, UserError } from './util.js';

export const SCRCPY_VERSION = '4.1';
export const SERVER_JAR = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', `scrcpy-server-v${SCRCPY_VERSION}.jar`);
export const REMOTE_JAR = '/data/local/tmp/agent-eye-server.jar';

// ---------------------------------------------------------------- Mac cameras

/** Parse `ffmpeg -f avfoundation -list_devices true -i ""` stderr. Screens are not cameras. */
export function parseAvfoundationDevices(text) {
  const out = [];
  let inVideo = false;
  for (const line of text.split('\n')) {
    if (/AVFoundation video devices/.test(line)) { inVideo = true; continue; }
    if (/AVFoundation audio devices/.test(line)) break;
    const m = inVideo && line.match(/\[(\d+)\]\s+(.+?)\s*$/);
    if (!m || /^Capture screen/i.test(m[2])) continue;
    out.push({ id: `mac:${m[2]}`, kind: 'mac', index: Number(m[1]), name: m[2] });
  }
  return out;
}

export async function listMacCameras() {
  if (process.platform !== 'darwin') return [];
  const ffmpeg = findBin('ffmpeg');
  if (!ffmpeg) return [];
  const { stderr } = await run(ffmpeg, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
  return parseAvfoundationDevices(stderr);
}

/** Map a profile source "mac:<name>" to the current avfoundation index. */
export async function resolveMacIndex(source) {
  const name = source.slice('mac:'.length);
  const cams = await listMacCameras();
  const hit = cams.find((c) => c.name === name);
  if (!hit) throw new UserError(`Camera "${name}" is not connected.`, { code: 3, hint: 'Run `agent-eye devices` to see what is available.' });
  return hit.index;
}

/** Best effort: ask avfoundation which modes a camera supports (it lists them when a mode is rejected). */
export function parseAvfoundationModes(text) {
  const modes = new Map();
  for (const m of text.matchAll(/(\d+)x(\d+)@\[([\d.]+)\s+([\d.]+)\]fps/g)) {
    const key = `${m[1]}x${m[2]}`;
    const max = Math.round(Number(m[4]));
    modes.set(key, Math.max(modes.get(key) ?? 0, max));
  }
  return [...modes].map(([size, maxFps]) => ({ size, maxFps }));
}

export async function macCameraModes(index) {
  const ffmpeg = findBin('ffmpeg');
  if (!ffmpeg) return [];
  const { stderr } = await run(ffmpeg, ['-hide_banner', '-f', 'avfoundation', '-framerate', '1000', '-i', `${index}:none`, '-t', '0.1', '-f', 'null', '-'], { timeoutMs: 15000 });
  return parseAvfoundationModes(stderr);
}

// -------------------------------------------------------------- Android phones

export function parseAdbDevices(text) {
  const out = [];
  for (const line of text.split('\n').slice(1)) {
    const m = line.match(/^(\S+)\s+(device|unauthorized|offline|no permissions)\b(.*)$/);
    if (!m) continue;
    const model = m[3].match(/model:(\S+)/)?.[1]?.replace(/_/g, ' ');
    out.push({ serial: m[1], state: m[2], model: model ?? m[1] });
  }
  return out;
}

/** Parse the server's `list_cameras=true list_camera_sizes=true` output. */
export function parseAndroidCameras(text) {
  const cams = [];
  let cam = null, highSpeed = false;
  for (const line of text.split('\n')) {
    const head = line.match(/--camera-id=(\d+)\s+\((\w+), (\d+x\d+), fps=\{([^}]*)\}(?:, zoom-range=\[([\d.]+), ([\d.]+)\])?/);
    if (head) {
      cam = {
        id: Number(head[1]), facing: head[2], maxSize: head[3],
        fps: head[4].split(',').map((s) => Number(s.trim())).filter(Boolean),
        zoomRange: head[5] ? [Number(head[5]), Number(head[6])] : [1, 1],
        sizes: [], highSpeed: [],
      };
      cams.push(cam); highSpeed = false;
      continue;
    }
    if (!cam) continue;
    if (/High speed capture/.test(line)) { highSpeed = true; continue; }
    const hs = highSpeed && line.match(/-\s+(\d+x\d+)\s+\(fps=\{([^}]*)\}\)/);
    if (hs) { cam.highSpeed.push({ size: hs[1], fps: hs[2].split(',').map((s) => Number(s.trim())) }); continue; }
    const sz = !highSpeed && line.match(/^\s+-\s+(\d+x\d+)\s*$/);
    if (sz) cam.sizes.push(sz[1]);
  }
  return cams;
}

export async function listAndroidPhones() {
  const adb = findBin('adb');
  if (!adb) return [];
  const { stdout } = await run(adb, ['devices', '-l']);
  return parseAdbDevices(stdout);
}

export async function pushServer(serial) {
  const adb = findBin('adb');
  const r = await run(adb, ['-s', serial, 'push', SERVER_JAR, REMOTE_JAR]);
  if (r.code !== 0) throw new UserError(`Could not push the camera server to ${serial}: ${r.stderr.trim()}`, { code: 3 });
}

export async function androidCameras(serial) {
  const adb = findBin('adb');
  await pushServer(serial);
  const { stdout, stderr, code } = await run(adb, ['-s', serial, 'shell', `CLASSPATH=${REMOTE_JAR}`, 'app_process', '/',
    'com.genymobile.scrcpy.Server', SCRCPY_VERSION, 'scid=00000001', 'log_level=info', 'list_cameras=true', 'list_camera_sizes=true'], { timeoutMs: 20000 });
  const cams = parseAndroidCameras(stdout);
  if (!cams.length) throw new UserError(`The phone reported no cameras (${(stderr || stdout).trim().slice(-200)}).`, { code: 3 });
  return cams;
}

/** All selectable cameras. Android phones that are not ready are reported with a reason. */
export async function listDevices({ capabilities = false } = {}) {
  const [mac, phones] = await Promise.all([listMacCameras(), listAndroidPhones()]);
  const devices = [...mac];
  const problems = [];
  for (const ph of phones) {
    if (ph.state !== 'device') {
      problems.push({ serial: ph.serial, state: ph.state, model: ph.model,
        hint: ph.state === 'unauthorized' ? 'Unlock the phone and accept the "Allow USB debugging" prompt.' : `adb reports the phone as "${ph.state}"; reconnect the cable.` });
      continue;
    }
    try {
      const cams = await androidCameras(ph.serial);
      for (const c of cams) {
        devices.push({ id: `android:${ph.serial}/${c.id}`, kind: 'android', serial: ph.serial, cameraId: c.id,
          name: `${ph.model} (${c.facing})`, ...(capabilities ? { caps: c } : { maxSize: c.maxSize, fps: c.fps, zoomRange: c.zoomRange, highSpeed: c.highSpeed }) });
      }
    } catch (e) {
      problems.push({ serial: ph.serial, state: ph.state, model: ph.model, hint: e.message });
    }
  }
  return { devices, problems };
}
