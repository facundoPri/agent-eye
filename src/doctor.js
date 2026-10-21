import { existsSync } from 'node:fs';
import { findBin, run } from './util.js';
import { SERVER_JAR, listAndroidPhones, listMacCameras } from './devices.js';
import { findConfigPath } from './config.js';

export async function ffmpegVersion() {
  const ffmpeg = findBin('ffmpeg');
  if (!ffmpeg) return null;
  const { stdout } = await run(ffmpeg, ['-version']);
  return stdout.match(/version (\S+)/)?.[1] ?? 'unknown';
}

/** Trigger (and test) the macOS camera permission by grabbing one frame. */
export async function macCameraAccess() {
  const ffmpeg = findBin('ffmpeg');
  const cams = await listMacCameras();
  if (!ffmpeg || !cams.length) return { ok: null, detail: 'no Mac camera found' };
  const r = await run(ffmpeg, ['-v', 'error', '-f', 'avfoundation', '-i', `${cams[0].index}:none`, '-frames:v', '1', '-f', 'null', '-'], { timeoutMs: 30000 });
  return r.code === 0 ? { ok: true, detail: `${cams[0].name} delivered a frame` }
    : { ok: false, detail: 'macOS did not allow camera access (System Settings > Privacy & Security > Camera, enable your terminal app).' };
}

export async function doctor() {
  const checks = [];
  const add = (name, ok, detail, fix) => checks.push({ name, ok, detail, ...(fix && !ok ? { fix } : {}) });
  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 20, `v${process.versions.node}`, 'Install Node 20 or newer.');
  const ver = await ffmpegVersion();
  add('ffmpeg', !!ver, ver ?? 'not found', 'brew install ffmpeg');
  add('ffprobe', !!findBin('ffprobe'), findBin('ffprobe') ?? 'not found', 'brew install ffmpeg');
  const adb = findBin('adb');
  add('adb (Android only)', !!adb, adb ?? 'not found', 'brew install android-platform-tools');
  add('camera server', existsSync(SERVER_JAR), existsSync(SERVER_JAR) ? 'bundled' : 'missing from the package');
  const cfg = findConfigPath();
  add('configuration', !!cfg, cfg ?? 'none yet', 'agent-eye setup');
  const mac = await listMacCameras();
  const phones = await listAndroidPhones();
  add('Mac cameras', true, mac.length ? mac.map((c) => c.name).join(', ') : 'none');
  add('Android phones', true, phones.length ? phones.map((p) => `${p.model} (${p.state})`).join(', ') : 'none connected');
  return { ok: checks.filter((c) => !c.name.includes('Android') && !c.name.includes('configuration')).every((c) => c.ok), checks };
}
