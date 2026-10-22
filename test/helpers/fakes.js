// Fake ffmpeg, ffprobe and adb for lifecycle tests. No camera, phone or real ffmpeg is ever touched:
// the fakes are the only tools on PATH and every test asserts that before it starts.
// Each fake records its pid in <dir>/pids (to count starts). Leftovers are found by command line:
// every fake and background worker has this test's private directory in its arguments.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scrcpyPacket } from '../../src/mpegts.js';
import { findBin } from '../../src/util.js';

const COMMON = `
const fs = require('fs');
const dir = process.env.FAKE_DIR;
const args = process.argv.slice(2);
const cfg = (name) => { try { return JSON.parse(fs.readFileSync(dir + '/' + name + '.json', 'utf8')); } catch { return {}; } };
const mark = (name) => fs.writeFileSync(dir + '/pids/' + name + '-' + process.pid, JSON.stringify(args));
`;

const FFMPEG = `${COMMON}
if (args.includes('-version')) { console.log('ffmpeg version fake'); process.exit(0); }
if (args.includes('-list_devices')) {
  process.stderr.write('[AVFoundation indev @ 0x1] AVFoundation video devices:\\n[AVFoundation indev @ 0x1] [0] Fake Camera\\n[AVFoundation indev @ 0x1] AVFoundation audio devices:\\n');
  process.exit(1);
}
const inFormat = args[args.lastIndexOf('-f', args.indexOf('-i')) + 1];
if (inFormat === 'image2pipe') { process.stdin.pipe(process.stdout); return; } // cropJpeg: pass the still through
mark('ffmpeg');
const c = cfg('ffmpeg');
const out = args[args.length - 1];
let bytes = 0, done = false;
const frames = out === 'pipe:1' ? setInterval(() => process.stdout.write(Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])), 30) : null;
const finish = (code) => {
  if (done || c.ignoreStop) return;
  done = true; clearInterval(frames);
  if (out !== 'pipe:1') fs.writeFileSync(out, c.output === 'partial' ? 'PARTIAL' : 'FAKEVIDEO ' + bytes + (inFormat === 'mpegts' ? ' ts=' + (tsOk ? 'ok' : 'bad') : ''));
  if (c.stderr) process.stderr.write(c.stderr + '\\n');
  process.stdin.destroy();
  setTimeout(() => process.exit(code ?? c.exitCode ?? 0), 20);
};
process.stdout.on('error', () => {});
process.on('SIGINT', () => finish(255));
let tsOk = true; // MPEG-TS input: every 188-byte packet starts with the sync byte
process.stdin.on('data', (d) => {
  if (inFormat === 'mpegts') for (let i = (188 - bytes % 188) % 188; i < d.length; i += 188) if (d[i] !== 0x47) tsOk = false;
  bytes += d.length; if (args.includes('avfoundation') && d.includes('q')) finish();
});
process.stdin.on('end', () => finish());
if (c.stallMs) { process.stdin.pause(); setTimeout(() => process.stdin.resume(), c.stallMs); }
setInterval(() => {}, 1000);
`;

const FFPROBE = `${COMMON}
const text = (() => { try { return fs.readFileSync(args[args.length - 1], 'utf8'); } catch { return ''; } })();
if (!text.startsWith('FAKEVIDEO')) { process.stderr.write('moov atom not found\\n'); process.exit(1); }
const pts = cfg('ffprobe').ptsTimes; // optional packet timestamps (seconds)
console.log(JSON.stringify({ streams: [{ codec_name: 'h264', width: 1920, height: 1080, nb_read_packets: String(pts?.length ?? 60) }], format: { duration: '1.000', size: String(text.length) },
  ...(pts && { packets: pts.map((t) => ({ pts_time: String(t) })) }) }));
`;

const ADB = `${COMMON}
const c = cfg('adb');
if (args[0] === 'devices') { console.log('List of devices attached\\nFAKE1 device usb:1 model:Fake_Phone\\n'); process.exit(0); }
const rest = args.slice(2);
if (rest[0] === 'push') process.exit(c.pushFail ? 1 : 0);
if (rest[0] === 'forward') {
  if (rest[1] === '--remove') process.exit(0);
  if (c.forwardFail) { process.stderr.write('forward failed\\n'); process.exit(1); }
  console.log(String(c.tunnelPort)); process.exit(0);
}
if (rest[0] === 'shell' && rest.includes('list_cameras=true')) {
  console.log('[server] INFO: List of cameras:\\n    --camera-id=0    (back, 1920x1080, fps={15, 30, 60})\\n        - 1920x1080\\n        - 1280x720');
  process.exit(0);
}
if (rest[0] === 'shell') { mark('adbserver'); console.log('[server] INFO: Device: fake'); setInterval(() => {}, 1000); return; }
process.exit(1);
`;

const PS = existsSync('/bin/ps') ? '/bin/ps' : '/usr/bin/ps'; // PATH holds only the fakes in-process

export const ANDROID_PROFILE = { source: 'android:FAKE1/0', width: 1920, height: 1080, fps: 30 };

/** Fake tools on a private PATH plus a fake phone tunnel served from this process. */
export async function setupFakes() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-eye-test-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin); mkdirSync(join(dir, 'pids'));
  for (const [name, body] of [['ffmpeg', FFMPEG], ['ffprobe', FFPROBE], ['adb', ADB]]) {
    const p = join(bin, name);
    writeFileSync(p, `#!${process.execPath}\n${body}`);
    chmodSync(p, 0o755);
  }
  const env = { ...process.env, PATH: bin, FAKE_DIR: dir, AGENT_EYE_HOME: join(dir, 'home') };
  for (const name of ['ffmpeg', 'ffprobe', 'adb']) {
    if (findBin(name, { env }) !== join(bin, name)) throw new Error(`refusing to run: ${name} does not resolve to the fake`);
  }

  // The phone end of `adb forward`, framed like scrcpy (12-byte header per packet).
  // mode: stream (a packet every 20 ms), silent, delay (stream after delayMs), flood.
  const tunnel = { mode: 'stream', delayMs: 0, flushed: 0, sockets: new Set() };
  const server = net.createServer((sock) => {
    tunnel.sockets.add(sock);
    sock.on('error', () => {});
    sock.on('close', () => tunnel.sockets.delete(sock));
    const stream = () => {
      if (tunnel.mode === 'flood') {
        const chunk = scrcpyPacket(Buffer.alloc(1 << 20, 7));
        const pump = () => { while (!sock.destroyed && sock.write(chunk)) tunnel.flushed += chunk.length; };
        sock.on('drain', () => { tunnel.flushed += chunk.length; pump(); });
        return pump();
      }
      let ptsUs = 0;
      const t = setInterval(() => (sock.destroyed ? clearInterval(t) : sock.write(scrcpyPacket(Buffer.alloc(4096, 1), { ptsUs: ptsUs += 20000 }))), 20);
      sock.on('close', () => clearInterval(t));
    };
    if (tunnel.mode === 'silent') return;
    if (tunnel.mode === 'delay') { const t = setTimeout(stream, tunnel.delayMs); sock.on('close', () => clearTimeout(t)); return; }
    stream();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const set = (name, cfg) => writeFileSync(join(dir, `${name}.json`), JSON.stringify(cfg));
  set('adb', { tunnelPort: port });
  set('ffmpeg', {});

  const kind = (cmd) => (cmd.includes('_worker') ? 'worker' : cmd.includes(`${bin}/ffmpeg`) ? 'ffmpeg'
    : cmd.includes(`${bin}/adb`) && cmd.includes('app_process') ? 'adbserver' : null);
  return {
    dir, env, tunnel,
    ffmpeg: (cfg) => set('ffmpeg', cfg),
    ffprobe: (cfg) => set('ffprobe', cfg),
    adb: (cfg) => set('adb', { tunnelPort: port, ...cfg }),
    /** Fake ffmpeg / camera servers and background workers of this test run that are still alive. */
    live: () => execFileSync(PS, ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' }).split('\n')
      .map((l) => l.trim().match(/^(\d+)\s+(.*)$/)).filter((m) => m && m[2].includes(dir) && kind(m[2]))
      .map((m) => ({ name: kind(m[2]), pid: Number(m[1]) })),
    started: (name) => readdirSync(join(dir, 'pids')).filter((f) => f.startsWith(`${name}-`)).length,
    /** Write a project with one Android profile; returns its directory. */
    project(profile = ANDROID_PROFILE) {
      const root = mkdtempSync(join(dir, 'proj-'));
      mkdirSync(join(root, '.agent-eye'));
      writeFileSync(join(root, '.agent-eye', 'config.json'), JSON.stringify({ version: 1, default: 'default', profiles: { default: profile } }));
      return root;
    },
    async close() {
      for (const p of this.live()) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } }
      for (const s of tunnel.sockets) s.destroy();
      await new Promise((r) => server.close(r));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Run `fn` with process.env pointing at the fakes (for in-process tests). */
export async function withEnv(env, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try { return await fn(); } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

export const waitFor = async (cond, ms = 5000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error(`timed out waiting for ${what}`);
};

export const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
