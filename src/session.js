import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { findBin, raceTimer, run, sleep, UserError } from './util.js';
import { REMOTE_JAR, SCRCPY_VERSION, pushServer, resolveMacIndex } from './devices.js';
import { androidServerOptions, inputArgs } from './ffargs.js';

const MAC_PERMISSION_HINT =
  'macOS blocked camera access for this terminal. Open System Settings > Privacy & Security > Camera, enable your terminal app, then retry.';

export function parseAndroidSource(source) {
  const m = source.match(/^android:([^/]+)\/(\d+)$/);
  if (!m) throw new UserError(`Not an Android source: ${source}`, { code: 2 });
  return { serial: m[1], cameraId: Number(m[2]) };
}

function explainFfmpegFailure(stderr, profile) {
  const tail = stderr.trim().split('\n').slice(-4).join('\n');
  if (/not authorized|permission|denied/i.test(stderr) && profile.source.startsWith('mac:')) return `${MAC_PERMISSION_HINT}\n${tail}`;
  if (/Selected (framerate|video size)|Supported modes/i.test(stderr)) return `The camera rejected ${profile.width}x${profile.height} at ${profile.fps} fps.\n${tail}`;
  return tail || 'ffmpeg stopped without output';
}

async function startAndroid(profile, ff, ffmpegDone) {
  const adb = findBin('adb');
  if (!adb) throw new UserError('adb is not installed.', { code: 3, hint: 'brew install android-platform-tools' });
  const { serial, cameraId } = parseAndroidSource(profile.source);
  await pushServer(serial);

  const scid = randomBytes(4).readUInt32BE() & 0x7fffffff;
  const scidHex = scid.toString(16).padStart(8, '0');
  const fwd = await run(adb, ['-s', serial, 'forward', 'tcp:0', `localabstract:scrcpy_${scidHex}`]);
  const port = Number(fwd.stdout.trim());
  if (fwd.code !== 0 || !port) throw new UserError(`adb forward failed: ${fwd.stderr.trim()}`, { code: 3 });

  const server = spawn(adb, ['-s', serial, 'shell', `CLASSPATH=${REMOTE_JAR}`, 'app_process', '/',
    'com.genymobile.scrcpy.Server', SCRCPY_VERSION, `scid=${scidHex}`, 'log_level=info', ...androidServerOptions(profile, cameraId)],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  const onLog = (d) => { serverLog = (serverLog + d).slice(-2000); };
  server.stdout.on('data', onLog); server.stderr.on('data', onLog);
  let serverExited = false;
  server.on('close', () => { serverExited = true; });

  let socket = null;
  const cleanup = async () => {
    socket?.destroy();
    server.kill('SIGTERM');
    await run(adb, ['-s', serial, 'forward', '--remove', `tcp:${port}`]);
  };

  // The tunnel accepts connections before the server listens, so retry until bytes arrive.
  const deadline = Date.now() + 12000;
  let firstChunk = null;
  while (!firstChunk && Date.now() < deadline) {
    if (serverExited) break;
    const s = await new Promise((resolve) => {
      const c = net.createConnection({ host: '127.0.0.1', port });
      c.once('data', (d) => resolve({ c, d }));
      c.once('error', () => resolve(null));
      c.once('close', () => resolve(null));
    });
    if (s) { socket = s.c; firstChunk = s.d; } else await sleep(150);
  }
  if (!firstChunk) {
    await cleanup();
    ff.kill('SIGKILL');
    const why = /in use|already|Could not open camera|camera.*(error|fail)/i.test(serverLog)
      ? 'The phone camera is busy (another app or a scrcpy window is using it).' : 'The phone camera did not start.';
    throw new UserError(`${why}\n${serverLog.trim().split('\n').slice(-5).join('\n')}`, { code: 3 });
  }
  let startedAt = Date.now();
  ff.stdin.on('error', () => {});
  ff.stdin.write(firstChunk);
  socket.on('data', (d) => { ff.stdin.write(d); });
  const endInput = () => { if (!ff.stdin.destroyed) ff.stdin.end(); };
  socket.on('close', endInput); socket.on('error', endInput);
  ffmpegDone.then(cleanup);
  return { startedAt, stopInput: async () => { socket.destroy(); endInput(); } };
}

/**
 * Open a camera with an ffmpeg output attached.
 * Resolves once frames are flowing. `stop()` finalises the output cleanly.
 */
export async function startSession(profile, outputArgs, { onStdout } = {}) {
  const ffmpeg = findBin('ffmpeg');
  if (!ffmpeg) throw new UserError('ffmpeg is not installed.', { code: 3, hint: 'brew install ffmpeg' });
  const isAndroid = profile.source.startsWith('android:');
  const macIndex = isAndroid ? undefined : await resolveMacIndex(profile.source);

  const ff = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...inputArgs(profile, { macIndex }), ...outputArgs],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  ff.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  if (onStdout) ff.stdout.on('data', onStdout); else ff.stdout.resume();
  const closed = new Promise((resolve) => ff.on('close', (code) => resolve({ code, stderr })));

  let android = null;
  let startedAt = Date.now();
  if (isAndroid) {
    android = await startAndroid(profile, ff, closed);
    startedAt = android.startedAt;
  } else {
    ff.stdin.on('error', () => {});
    // avfoundation failures (no permission, bad mode) surface within about a second.
    const early = await Promise.race([closed, raceTimer(1500).then(() => null)]);
    if (early) throw new UserError(`The camera did not start: ${explainFfmpegFailure(early.stderr, profile)}`, { code: 3 });
    startedAt = Date.now();
  }

  let stopping = null;
  const stop = () => stopping ??= (async () => {
    if (isAndroid) await android.stopInput(); else ff.stdin.write('q');
    const res = await Promise.race([closed, raceTimer(10000).then(() => null)]);
    if (!res) { ff.kill('SIGKILL'); return closed; }
    return res;
  })();
  return { stop, closed, startedAt, explain: (r) => explainFfmpegFailure(r.stderr, profile) };
}
