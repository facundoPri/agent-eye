// Pure builders for ffmpeg arguments. No process is spawned here, so they are unit-testable.
import { FULL_CROP } from './config.js';

const even = (expr) => `trunc(${expr}/2)*2`;

export function isFullCrop(c = FULL_CROP) {
  return c.x === 0 && c.y === 0 && c.w === 1 && c.h === 1;
}

/** Rotation first, then crop: the crop rectangle is defined on the rotated image the user sees. */
export function rotateFilters(rotate) {
  return { 0: [], 90: ['transpose=1'], 180: ['hflip', 'vflip'], 270: ['transpose=2'] }[rotate] ?? [];
}

export function cropFilter(crop) {
  if (isFullCrop(crop)) return [];
  const { x, y, w, h } = crop;
  return [`crop=w=${even(`iw*${w}`)}:h=${even(`ih*${h}`)}:x=${even(`iw*${x}`)}:y=${even(`ih*${y}`)}`];
}

export function framingFilters(profile, { crop = true } = {}) {
  return [...rotateFilters(profile.rotate ?? 0), ...(crop ? cropFilter(profile.crop) : [])];
}

/** Android streams are already H.264: copy them untouched unless the framing needs a re-encode. */
export function canStreamCopy(profile) {
  return profile.source.startsWith('android:') && framingFilters(profile).length === 0;
}

export function inputArgs(profile, { macIndex } = {}) {
  if (profile.source.startsWith('android:')) {
    // MPEG-TS carrying the phone's capture timestamps (see mpegts.js), not arrival times on the Mac.
    return ['-flags', 'low_delay', '-probesize', '1000000', '-analyzeduration', '0', '-f', 'mpegts', '-i', 'pipe:0'];
  }
  if (macIndex === undefined) throw new Error('macIndex is required for a Mac camera');
  return ['-f', 'avfoundation', '-framerate', String(profile.fps), '-video_size', `${profile.width}x${profile.height}`, '-i', `${macIndex}:none`];
}

/** Motion-JPEG frames on stdout for the browser preview and for stills. */
export function previewOutputArgs(profile, { width = 960, fps = 15, quality = 6, applyCrop = false } = {}) {
  const chain = [...framingFilters(profile, { crop: applyCrop }), `fps=${fps}`, ...(width ? [`scale=${width}:-2`] : [])];
  return ['-an', '-vf', chain.join(','), '-pix_fmt', 'yuvj420p', '-q:v', String(quality), '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'];
}

export function recordOutputArgs(profile, outPath) {
  const filters = framingFilters(profile);
  const base = ['-an', '-fps_mode', 'passthrough'];
  if (canStreamCopy(profile)) return [...base, '-c:v', 'copy', outPath];
  return [...base, ...(filters.length ? ['-vf', filters.join(',')] : []),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', outPath];
}

/**
 * Options for the Android camera server. Slow motion needs max_fps and, above 120 fps,
 * an encoder operating rate; both were needed to get real 120/240 fps on a Motorola edge 40 pro.
 */
export function androidServerOptions(profile, cameraId) {
  const opts = [
    'video_source=camera', `camera_id=${cameraId}`, `camera_size=${profile.width}x${profile.height}`,
    `camera_fps=${profile.fps}`, `max_fps=${profile.fps}`,
    `video_bit_rate=${Math.round((profile.bitrate ?? (profile.fps > 60 ? 40 : 20)) * 1e6)}`,
    'audio=false', 'control=false', 'tunnel_forward=true',
    // Bare packets, each with its 12-byte header (capture PTS + size): send_frame_meta is what raw_stream turns off.
    'send_device_meta=false', 'send_dummy_byte=false', 'send_stream_meta=false', 'send_frame_meta=true',
  ];
  if (profile.zoom > 1) opts.push(`camera_zoom=${profile.zoom}`);
  if (profile.fps > 60) opts.push('camera_high_speed=true');
  if (profile.fps > 120) opts.push(`video_codec_options=operating-rate:int=${Math.round(profile.fps * 2)},priority:int=0`);
  return opts;
}
