import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { findBin, raceTimer, run, UserError } from './util.js';
import { cropFilter, previewOutputArgs, recordOutputArgs, canStreamCopy } from './ffargs.js';
import { JpegSplitter } from './mjpeg.js';
import { startSession } from './session.js';

/** Probe a finished recording. measuredFps comes from packet count over duration, not from what was requested. */
export async function probeVideo(path) {
  const ffprobe = findBin('ffprobe');
  if (!ffprobe) return null;
  const r = await run(ffprobe, ['-v', 'error', '-count_packets', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height,nb_read_packets:format=duration,size', '-of', 'json', path]);
  if (r.code !== 0) return null;
  const j = JSON.parse(r.stdout);
  const s = j.streams?.[0] ?? {};
  const duration = Number(j.format?.duration) || 0;
  const frames = Number(s.nb_read_packets) || 0;
  return { codec: s.codec_name, width: s.width, height: s.height, frames, durationSec: duration,
    measuredFps: duration > 0 ? Math.round((frames / duration) * 10) / 10 : 0, bytes: Number(j.format?.size) || 0 };
}

export async function recordToFile(profile, outPath, { durationSec, signal, onStarted } = {}) {
  const out = resolve(outPath);
  mkdirSync(dirname(out), { recursive: true });
  const session = await startSession(profile, recordOutputArgs(profile, out));
  const startedAt = session.startedAt;
  onStarted?.(startedAt);
  const ended = new Promise((res) => {
    if (durationSec) setTimeout(res, durationSec * 1000);
    signal?.addEventListener('abort', res, { once: true });
  });
  const early = await Promise.race([session.closed, ended.then(() => null)]);
  if (early) throw new UserError(`Recording stopped by itself: ${session.explain(early)}`, { code: 3 });
  const stoppedAt = Date.now();
  const res = await session.stop();
  if (res.code !== 0 && !existsSync(out)) throw new UserError(`ffmpeg failed: ${session.explain(res)}`, { code: 3 });
  const probe = await probeVideo(out);
  const summary = {
    file: out, profile: profile.name ?? null, source: profile.source,
    requested: { width: profile.width, height: profile.height, fps: profile.fps },
    streamCopy: canStreamCopy(profile),
    startedAtMs: startedAt, stoppedAtMs: stoppedAt, // host clock: use these to line up video with other logs
    ...probe,
  };
  summary.warnings = [];
  if (probe && probe.measuredFps && probe.measuredFps < profile.fps * 0.9) {
    summary.warnings.push(`Measured ${probe.measuredFps} fps, below the ${profile.fps} fps requested.`);
  }
  writeFileSync(out.slice(0, out.length - extname(out).length) + '.json', JSON.stringify(summary, null, 2) + '\n');
  return summary;
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
export async function takeSnapshot(profile, outPath, { warmupMs = 2000 } = {}) {
  let latest = null, frames = 0;
  const splitter = new JpegSplitter((f) => { latest = Buffer.from(f); frames += 1; });
  const session = await startSession(profile, previewOutputArgs(profile, { width: 0, fps: 5, quality: 2, applyCrop: true }), { onStdout: (d) => splitter.push(d) });
  const waited = Date.now();
  while ((Date.now() - waited < warmupMs || frames < 3) && Date.now() - waited < warmupMs + 6000) {
    if (await Promise.race([session.closed, raceTimer(100).then(() => null)])) break;
  }
  const res = await session.stop();
  if (!latest) throw new UserError(`No frames arrived from the camera: ${session.explain(res)}`, { code: 3 });
  const out = resolve(outPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, latest);
  return { file: out, bytes: latest.length };
}

