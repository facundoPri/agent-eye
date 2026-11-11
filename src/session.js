import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { findBin, raceTimer, run, sleep, UserError } from './util.js';
import { REMOTE_JAR, SCRCPY_VERSION, pushServer, resolveMacIndex } from './devices.js';
import { androidServerOptions, inputArgs, regionArg } from './ffargs.js';
import { scrcpyToTs } from './mpegts.js';
import { camera3aCollector } from './camera3a.js';

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

export const cancelledError = () => new UserError('Stopped before the camera started; nothing was recorded.', { code: 1 });

/** Connect to the tunnel and wait for the first bytes. Resolves null on error, close, timeout or `interrupted`. */
function firstBytes(port, ms, interrupted) {
  return new Promise((resolve) => {
    let settled = false;
    const c = net.createConnection({ host: '127.0.0.1', port });
    const done = (v) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (v) c.pause(); else c.destroy(); // paused: nothing is lost before the stream is piped on
      resolve(v);
    };
    const timer = setTimeout(() => done(null), ms);
    c.once('data', (d) => done({ c, d }));
    c.once('error', () => done(null));
    c.once('close', () => done(null));
    interrupted.then(() => done(null));
  });
}

async function startAndroid(profile, ff, ffmpegDone, { signal, startTimeoutMs, waitReady }) {
  const adb = findBin('adb');
  const { serial, cameraId } = parseAndroidSource(profile.source);
  await pushServer(serial);
  if (signal?.aborted) throw cancelledError();

  const scid = randomBytes(4).readUInt32BE() & 0x7fffffff;
  const scidHex = scid.toString(16).padStart(8, '0');
  const fwd = await run(adb, ['-s', serial, 'forward', 'tcp:0', `localabstract:scrcpy_${scidHex}`]);
  const port = Number(fwd.stdout.trim());
  if (fwd.code !== 0 || !port) throw new UserError(`adb forward failed: ${fwd.stderr.trim()}`, { code: 3 });

  let server = null, socket = null, serverLog = '', serverExited = false, ffExited = false;
  const camera3a = camera3aCollector();
  const cleanup = async () => {
    socket?.destroy();
    server?.kill('SIGTERM');
    await run(adb, ['-s', serial, 'forward', '--remove', `tcp:${port}`]);
  };
  let wake;
  const interrupted = new Promise((r) => { wake = r; });
  signal?.addEventListener('abort', wake, { once: true });
  ffmpegDone.then(() => { ffExited = true; wake(); });

  let firstChunk = null;
  try {
    server = spawn(adb, ['-s', serial, 'shell', `CLASSPATH=${REMOTE_JAR}`, 'app_process', '/',
      'com.genymobile.scrcpy.Server', SCRCPY_VERSION, `scid=${scidHex}`, 'log_level=info', ...androidServerOptions(profile, cameraId)],
    { stdio: ['pipe', 'pipe', 'pipe'] });
    server.stdin.on('error', () => {});
    const onLog = (d) => { serverLog = (serverLog + d).slice(-2000); };
    server.stdout.on('data', (d) => { onLog(d); camera3a.push(String(d)); }); server.stderr.on('data', onLog);
    server.on('error', onLog);
    server.on('close', () => { serverExited = true; wake(); });

    // The tunnel accepts connections before the server listens, so retry until bytes arrive.
    // Each attempt is bounded by the deadline: a tunnel that connects but stays silent must not hang.
    const deadline = Date.now() + startTimeoutMs;
    while (!firstChunk && Date.now() < deadline && !serverExited && !ffExited && !signal?.aborted) {
      const s = await firstBytes(port, deadline - Date.now(), interrupted);
      if (s) { socket = s.c; firstChunk = s.d; } else await Promise.race([sleep(150), interrupted]);
    }
    if (!firstChunk || signal?.aborted) {
      if (signal?.aborted) throw cancelledError();
      const unsupported = /Error configuring streams|Function not implemented/i.test(serverLog);
      const busy = !unsupported && /in use|already|Could not open camera|camera.*(error|fail)/i.test(serverLog);
      const why = unsupported ? `The phone camera cannot record ${profile.width}x${profile.height} at ${profile.fps} fps (it refused the configuration).`
        : busy ? 'The phone camera is busy (another app or a scrcpy window is using it).'
        : ffExited ? 'ffmpeg stopped while the phone camera was starting.'
          : serverExited ? 'The phone camera did not start.' : `The phone camera sent nothing within ${Math.round(startTimeoutMs / 1000)} s.`;
      throw new UserError(`${why}\n${serverLog.trim().split('\n').slice(-5).join('\n')}`.trim(), { code: 3 });
    }
  } catch (e) {
    await cleanup();
    throw e;
  } finally {
    signal?.removeEventListener('abort', wake);
  }

  const startedAt = Date.now();
  const ts = scrcpyToTs();
  // pipe() pauses the phone stream while ffmpeg is behind (a slow re-encode at 240 fps) instead of buffering it in memory.
  ts.pipe(ff.stdin);
  ts.on('error', () => { socket.destroy(); ff.stdin.end(); });
  ts.write(firstChunk);
  socket.pipe(ts);
  const endInput = () => { if (!ts.writableEnded && !ts.destroyed) ts.end(); };
  socket.on('close', endInput); socket.on('error', endInput);
  ffmpegDone.then(cleanup);
  // Autofocus searches for about 1.5 s when the camera opens, and the exposure / white balance locks engage
  // after it has metered the scene. A recording counts as started only then, so whatever happens after
  // `start` returns is filmed in focus and with the locks on. (The file starts earlier, with the search.)
  if (waitReady) {
    const aborted = new Promise((r) => (signal?.aborted ? r() : signal?.addEventListener('abort', r, { once: true })));
    await Promise.race([camera3a.waitReady(4000, { locks: !!(profile.exposureLock || profile.whiteBalanceLock) }), interrupted, aborted]);
  }
  return { startedAt, camera3a, control: cameraControl(server, camera3a), stopInput: async () => { socket.destroy(); endInput(); } };
}

/**
 * Live changes to a running phone camera, sent to its server's stdin (no restart, no blink).
 * Regions are in camera coordinates (see framing.js: viewToCamera).
 */
function cameraControl(server, camera3a) {
  const send = (cmd) => {
    if (!server.stdin.writable) throw new UserError('The phone camera has stopped.', { code: 3 });
    server.stdin.write(`${cmd}\n`);
  };
  const command = async (cmd, ms = 3000) => {
    const mark = camera3a.mark();
    send(cmd);
    const r = await camera3a.next((e) => (e.event === 'done' || e.event === 'failed') && e.command === cmd, ms, mark);
    if (!r) throw new UserError(`The phone camera did not answer "${cmd}".`, { code: 3 });
    if (r.event === 'failed') throw new UserError(`The phone camera refused "${cmd}".`, { code: 3 });
  };
  return {
    /**
     * Zoom, then wait for a frame taken at that zoom (and a moment for a lens switch to settle).
     * Resolves with the lens id the camera reports using (null if it does not say).
     */
    async zoom(z) {
      await command(`zoom ${z}`);
      const mark = camera3a.mark();
      await camera3a.next((r) => typeof r.zoom === 'number' && Math.abs(r.zoom - z) < 0.02, 2500, mark);
      await sleep(250);
      const after = camera3a.mark();
      const r = await camera3a.next((x) => typeof x.zoom === 'number', 1500, after);
      return r?.lens !== undefined ? String(r.lens) : null;
    },
    /** A fixed distance in diopters, or 'auto' for continuous autofocus. */
    focus: (d) => command(`focus ${d}`),
    region: (r) => command(r ? `af_region ${regionArg(r).replaceAll(',', ' ')}` : 'af_region none'),
    /** One autofocus scan (on `region` when given); resolves { focus, ok }, or null if it never finished. */
    async scan(region) {
      if (region) await this.region(region);
      const mark = camera3a.mark();
      send('af_scan');
      const e = await camera3a.next((x) => x.event === 'scanned', 6000, mark);
      return e ? { focus: e.focus, ok: e.ok } : null;
    },
    lock: (which, on) => command(`${which === 'exposure' ? 'ae' : 'awb'}_lock ${on ? 1 : 0}`),
  };
}

/**
 * Open a camera with an ffmpeg output attached.
 * Resolves once frames are flowing (with `waitReady`, once a phone camera's focus has also settled and its
 * locks are on, up to 4 s more); on any failure (or `signal` aborting) everything it started is stopped.
 * `stop()` finalises the output cleanly, or kills ffmpeg after 10 s; the result says which.
 */
export async function startSession(profile, outputArgs, { onStdout, signal, startTimeoutMs = 12000, waitReady = false } = {}) {
  const ffmpeg = findBin('ffmpeg');
  if (!ffmpeg) throw new UserError('ffmpeg is not installed.', { code: 3, hint: 'brew install ffmpeg' });
  const isAndroid = profile.source.startsWith('android:');
  if (isAndroid && !findBin('adb')) throw new UserError('adb is not installed.', { code: 3, hint: 'brew install android-platform-tools' });
  const macIndex = isAndroid ? undefined : await resolveMacIndex(profile.source);
  if (signal?.aborted) throw cancelledError();

  const ff = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...inputArgs(profile, { macIndex }), ...outputArgs],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  ff.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  ff.on('error', (e) => { stderr += String(e); });
  ff.stdin.on('error', () => {});
  if (onStdout) ff.stdout.on('data', onStdout); else ff.stdout.resume();
  const closed = new Promise((resolve) => ff.on('close', (code, sig) => resolve({ code, signal: sig, stderr })));

  let android = null;
  let startedAt;
  try {
    if (isAndroid) {
      android = await startAndroid(profile, ff, closed, { signal, startTimeoutMs, waitReady });
      startedAt = android.startedAt;
    } else {
      // avfoundation failures (no permission, bad mode) surface within about a second.
      const early = await Promise.race([closed, raceTimer(1500).then(() => null)]);
      // Ctrl-C in a terminal also reaches ffmpeg, which then exits on its own: that is a cancel, not a camera fault.
      if (early) throw signal?.aborted ? cancelledError() : new UserError(`The camera did not start: ${explainFfmpegFailure(early.stderr, profile)}`, { code: 3 });
      startedAt = Date.now();
    }
  } catch (e) {
    ff.kill('SIGKILL');
    throw e;
  }

  let stopping = null;
  const stop = () => stopping ??= (async () => {
    if (isAndroid) await android.stopInput(); else ff.stdin.write('q');
    const res = await Promise.race([closed, raceTimer(10000).then(() => null)]);
    if (!res) { ff.kill('SIGKILL'); return { ...(await closed), killed: true }; }
    return res;
  })();
  return { stop, closed, startedAt, camera3a: android?.camera3a ?? null, control: android?.control ?? null,
    explain: (r) => explainFfmpegFailure(r.stderr, profile) };
}
