import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { findBin, raceTimer, run, UserError } from './util.js';
import { cropFilter, previewOutputArgs, recordOutputArgs, canStreamCopy } from './ffargs.js';
import { JpegSplitter } from './mjpeg.js';
import { cancelledError, startSession } from './session.js';

/**
 * Probe a finished recording. measuredFps comes from packet count over duration, not from what was requested.
 * Returns null when ffprobe is not installed, { unchecked } when it ran out of time (a very long file),
 * and { unreadable } when the file is not a playable video.
 */
export async function probeVideo(path) {
  const ffprobe = findBin('ffprobe');
  if (!ffprobe) return null;
  const r = await run(ffprobe, ['-v', 'error', '-count_packets', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height,nb_read_packets:format=duration,size:packet=pts_time', '-of', 'json', path], { timeoutMs: 180000 });
  if (r.code === -2) return { unchecked: 'ffprobe took longer than 3 minutes' };
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { /* reported below */ }
  const s = j?.streams?.[0];
  if (r.code !== 0 || !s) return { unreadable: r.stderr.trim().split('\n').pop() || 'no video stream' };
  const duration = Number(j.format?.duration) || 0;
  const frames = Number(s.nb_read_packets) || 0;
  const timing = frameTiming((j.packets ?? []).map((p) => Number(p.pts_time)).filter(Number.isFinite));
  return { codec: s.codec_name, width: s.width, height: s.height, frames, durationSec: duration,
    measuredFps: duration > 0 ? Math.round((frames / duration) * 10) / 10 : 0, bytes: Number(j.format?.size) || 0,
    ...(timing && { frameIntervalMs: timing }) };
}

/**
 * Spacing of frame timestamps (seconds, any order): median, extremes and how many intervals are off
 * by more than half the median. Capture timestamps are steady; arrival times on the host are bunched.
 */
export function frameTiming(pts) {
  if (pts.length < 3) return null;
  const t = [...pts].sort((a, b) => a - b);
  const d = t.slice(1).map((v, i) => (v - t[i]) * 1000);
  const sorted = [...d].sort((a, b) => a - b);
  const median = sorted[Math.floor(d.length / 2)];
  const r = (v) => Math.round(v * 100) / 100;
  return { median: r(median), min: r(sorted[0]), max: r(sorted.at(-1)), irregular: d.filter((v) => Math.abs(v - median) > median / 2).length };
}

/** A warning when more than 1% of frame intervals are irregular, else null. */
export function timingWarning(timing, frames) {
  if (!timing || timing.irregular <= Math.max(2, (frames - 1) * 0.01)) return null;
  return `Frame timestamps are irregular: ${timing.irregular} of ${frames - 1} intervals are off by more than half the typical ${timing.median} ms `
    + `(range ${timing.min}–${timing.max} ms). Playback, seeking and per-frame timing will be uneven; dropped frames also show up here.`;
}

/**
 * Why a stopped ffmpeg did not leave a finished file, or null if it did.
 * 0 is a normal end; 255 is ffmpeg finishing after a signal (Ctrl-C reaches it with the CLI), which still writes the trailer.
 */
export function recordingProblem(res, probe) {
  if (res.killed || res.signal) return `ffmpeg had to be killed (${res.signal ?? 'SIGKILL'}), so the file was not finalised`;
  if (res.code !== 0 && res.code !== 255) return `ffmpeg exited with code ${res.code}`;
  if (probe?.unchecked) return null;
  if (probe?.unreadable) return `the file is not a readable video (${probe.unreadable})`;
  if (probe && !probe.frames) return 'the file has no video frames';
  return null;
}

export const sidecarPath = (out) => out.slice(0, out.length - extname(out).length) + '.json';

/**
 * Record until `durationSec` passes or `signal` aborts. Resolves with the summary only when the file
 * is a finished, readable video; otherwise throws (the partial file, if any, is left in place).
 */
export async function recordToFile(profile, outPath, { durationSec, signal, onStarted, startTimeoutMs } = {}) {
  const out = resolve(outPath);
  mkdirSync(dirname(out), { recursive: true });
  rmSync(sidecarPath(out), { force: true }); // a summary left from an earlier take must not describe this one
  const session = await startSession(profile, recordOutputArgs(profile, out), { signal, startTimeoutMs });
  let timer, finish;
  const ended = new Promise((res) => { finish = res; });
  try {
    if (signal?.aborted) { await session.stop(); throw cancelledError(); }
    const startedAt = session.startedAt;
    onStarted?.(startedAt);
    if (durationSec) timer = setTimeout(finish, durationSec * 1000);
    signal?.addEventListener('abort', finish, { once: true });
    const early = await Promise.race([session.closed, ended.then(() => null)]);
    if (early && !signal?.aborted) throw new UserError(`Recording stopped by itself: ${session.explain(early)}`, { code: 3, hint: `Whatever was written is in ${out}.` });
    const stoppedAt = Date.now();
    const res = early ?? await session.stop();
    const probe = await probeVideo(out);
    const problem = recordingProblem(res, probe);
    if (problem) throw new UserError(`Recording failed: ${problem}. ${session.explain(res)}`, { code: 3, hint: `The incomplete file is ${out}.` });
    const summary = {
      file: out, profile: profile.name ?? null, source: profile.source,
      requested: { width: profile.width, height: profile.height, fps: profile.fps },
      streamCopy: canStreamCopy(profile),
      startedAtMs: startedAt, stoppedAtMs: stoppedAt, // host clock: use these to line up video with other logs
      ...probe,
    };
    summary.warnings = [];
    if (!probe) summary.warnings.push('ffprobe is not installed: the file was not checked and frames/fps are unknown.');
    if (probe?.unchecked) summary.warnings.push(`${probe.unchecked}: the file was not checked and frames/fps are unknown.`);
    if (probe?.measuredFps && probe.measuredFps < profile.fps * 0.9) {
      summary.warnings.push(`Measured ${probe.measuredFps} fps, below the ${profile.fps} fps requested.`);
    }
    const jitter = timingWarning(probe?.frameIntervalMs, probe?.frames);
    if (jitter) summary.warnings.push(jitter);
    writeFileSync(sidecarPath(out), JSON.stringify(summary, null, 2) + '\n');
    return summary;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', finish);
  }
}

/** Crop an in-memory JPEG with the profile's crop rectangle. */
export async function cropJpeg(jpeg, crop) {
  const filters = cropFilter(crop);
  if (!filters.length) return jpeg;
  const ffmpeg = findBin('ffmpeg');
  const { spawn } = await import('node:child_process');
  return new Promise((resolveBuf, reject) => {
    const p = spawn(ffmpeg, ['-v', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-i', 'pipe:0', '-vf', filters.join(','), '-q:v', '3', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1']);
    const chunks = [];
    p.stdout.on('data', (d) => chunks.push(d));
    p.on('close', (code) => (code === 0 ? resolveBuf(Buffer.concat(chunks)) : reject(new Error('crop failed'))));
    p.stdin.on('error', () => {});
    p.stdin.end(jpeg);
  });
}

/** One full-resolution still with the profile's framing applied. Waits so exposure and focus settle. */
export async function takeSnapshot(profile, outPath, { warmupMs = 2000, signal } = {}) {
  let latest = null, frames = 0;
  const splitter = new JpegSplitter((f) => { latest = Buffer.from(f); frames += 1; });
  const session = await startSession(profile, previewOutputArgs(profile, { width: 0, fps: 5, quality: 2, applyCrop: true }), { onStdout: (d) => splitter.push(d), signal });
  const waited = Date.now();
  while ((Date.now() - waited < warmupMs || frames < 3) && Date.now() - waited < warmupMs + 6000 && !signal?.aborted) {
    if (await Promise.race([session.closed, raceTimer(100).then(() => null)])) break;
  }
  const res = await session.stop();
  if (signal?.aborted) throw cancelledError();
  if (!latest) throw new UserError(`No frames arrived from the camera: ${session.explain(res)}`, { code: 3 });
  const out = resolve(outPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, latest);
  return { file: out, bytes: latest.length };
}

