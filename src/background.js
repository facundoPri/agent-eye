// State and control channel of the background recorder (`start` / `stop` / `status`).
//
// recording.json belongs to one recording, identified by a random id. Every change to it happens
// under recording.lock, so two `start`s cannot both claim the camera and nobody removes a state
// that belongs to someone else. The worker answers on a 127.0.0.1 port only to requests carrying
// its id: a recycled pid or a dead worker is never mistaken for the recorder.
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { sleep, UserError } from './util.js';

const LOCK_STALE_MS = 10000; // the lock is held for milliseconds; an older one was left by a crash
const STARTING_GRACE_MS = 60000; // a claim without a control port yet is a worker still booting

export const statePath = (configPath) => join(dirname(configPath), 'recording.json');

export function readState(sf) {
  try { return JSON.parse(readFileSync(sf, 'utf8')); } catch { return null; }
}

function writeState(sf, st) {
  mkdirSync(dirname(sf), { recursive: true });
  const tmp = `${sf}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(st, null, 2) + '\n');
  renameSync(tmp, sf);
}

export async function withLock(sf, fn) {
  const lock = `${sf.replace(/\.json$/, '')}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  for (let i = 0; ; i++) {
    try { closeSync(openSync(lock, 'wx')); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock); } catch { /* gone already */ }
      if (i > 400) throw new UserError(`${lock} stays locked; remove it if no agent-eye command is running.`, { code: 1 });
      await sleep(25);
    }
  }
  try { return await fn(); } finally { try { unlinkSync(lock); } catch { /* already gone */ } }
}

/** Send one request to the worker and wait for its one-line reply. Null if nobody with that id answers. */
export function ask(port, msg, timeoutMs) {
  return new Promise((resolve) => {
    let buf = '', settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); sock.destroy(); resolve(v); } };
    const timer = setTimeout(() => done(null), timeoutMs);
    const sock = net.createConnection({ host: '127.0.0.1', port }, () => sock.write(JSON.stringify(msg) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let reply = null;
      try { reply = JSON.parse(buf.slice(0, nl)); } catch { /* not our worker */ }
      done(reply?.id === msg.id ? reply : null);
    });
    sock.on('error', () => done(null));
    sock.on('close', () => done(null));
  });
}

/** Is the recording described by `st` still in progress? */
async function isLive(st) {
  if (!st || st.result) return false;
  if (!st.port) return Date.now() - (st.createdAt ?? 0) < STARTING_GRACE_MS;
  return !!(await ask(st.port, { id: st.id, cmd: 'status' }, 2000));
}

/** Claim the recorder for a new recording, or throw if one is already running. */
export function claim(sf, st) {
  return withLock(sf, async () => {
    const cur = readState(sf);
    if (await isLive(cur)) {
      throw new UserError(`A recording is already running (${cur.out}).`, { code: 1, hint: 'Run `agent-eye stop` first.' });
    }
    writeState(sf, { ...st, createdAt: Date.now() });
  });
}

/** Merge `patch` into the state if it still belongs to recording `id`. */
export function updateState(sf, id, patch) {
  return withLock(sf, () => {
    const cur = readState(sf);
    if (cur?.id === id) writeState(sf, { ...cur, ...patch });
  });
}

/** Remove the state if it still belongs to recording `id`. */
export function removeState(sf, id) {
  return withLock(sf, () => {
    if (readState(sf)?.id === id) unlinkSync(sf);
  });
}

/** What `status` reports. A state whose worker is gone without a result is stale. */
export async function recorderStatus(sf) {
  const st = readState(sf);
  if (!st) return { running: false };
  if (st.result) return { running: false, last: st.result };
  const info = st.port ? await ask(st.port, { id: st.id, cmd: 'status' }, 2000) : null;
  if (info) { const { id: _id, ...rest } = info; return { running: true, ...rest }; }
  if (await isLive(st)) return { running: true, ready: false, out: st.out };
  return { running: false, stale: true };
}

/**
 * Ask the recorder to stop and return its result ({ ok, summary } or { ok: false, error, ... }).
 * Waits for a worker that is still booting, and never signals a process by pid.
 */
export async function stopRecorder(sf, { timeoutMs = 60000 } = {}) {
  let st = readState(sf);
  if (!st) throw new UserError('No background recording is running.', { code: 1 });
  for (let i = 0; !st.port && !st.result && i < 100 && Date.now() - (st.createdAt ?? 0) < STARTING_GRACE_MS; i++) {
    await sleep(100);
    st = readState(sf);
    if (!st) throw new UserError('No background recording is running.', { code: 1 });
  }
  let res = st.result ?? (st.port ? await ask(st.port, { id: st.id, cmd: 'stop' }, timeoutMs) : null);
  const now = readState(sf);
  const mine = now?.id === st.id ? now : null;
  res ??= mine?.result ?? null; // the worker may have finished while we were connecting
  if (!res && await isLive(mine)) throw new UserError(`The recorder did not answer within ${timeoutMs / 1000} s; it may still be ${st.port ? 'recording' : 'starting'}.`, { code: 1, hint: 'Run `agent-eye status`, then `agent-eye stop` again.' });
  await removeState(sf, st.id);
  return res;
}

/**
 * The worker's end of the channel. `onStop` runs for each stop request; the request is answered
 * by `finish(result)` once the recording is finalised. `info()` answers status requests.
 */
export async function listenControl(id, { info, onStop }) {
  let result = null;
  const waiters = new Set();
  const reply = (sock, body) => sock.end(JSON.stringify({ id, ...body }) + '\n');
  const server = net.createServer((sock) => {
    let buf = '', handled = false;
    sock.on('error', () => {});
    sock.on('close', () => waiters.delete(sock));
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (handled || nl < 0) return;
      handled = true;
      let msg = null;
      try { msg = JSON.parse(buf.slice(0, nl)); } catch { /* ignored below */ }
      if (msg?.id !== id) return sock.destroy();
      if (msg.cmd === 'status') return reply(sock, info());
      if (msg.cmd !== 'stop') return sock.destroy();
      if (result) return reply(sock, result);
      waiters.add(sock);
      onStop();
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    port: server.address().port,
    finish(res) {
      result = res;
      for (const sock of waiters) reply(sock, res);
      server.close();
    },
  };
}
