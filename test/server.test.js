// The configure/preview web server against fake tools (see helpers/fakes.js). No hardware.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { ANDROID_PROFILE, setupFakes, waitFor, withEnv } from './helpers/fakes.js';
import { serveConfigurator } from '../src/server.js';

let fakes;
test.before(async () => { fakes = await setupFakes(); });
test.after(() => fakes.close());
test.afterEach(async () => {
  await waitFor(() => fakes.live().length === 0, 3000, 'fake processes to exit').catch(() => {});
  assert.deepEqual(fakes.live(), [], 'a test left processes running');
});

/** Start the server; resolves with helpers once it listens. */
async function open(opts = {}) {
  const abort = new AbortController();
  const configPath = join(fakes.project(), '.agent-eye', 'config.json');
  let url;
  const ready = new Promise((r) => { opts.onReady = (u) => { url = new URL(u); r(); }; });
  const done = serveConfigurator({ configPath, projectRoot: fakes.dir, mode: 'configure', signal: abort.signal, ...opts });
  await ready;
  const token = url.searchParams.get('t');
  const call = async (method, path, body) => {
    const r = await fetch(new URL(path, url), { method, headers: { 'x-agent-eye-token': token, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { url, token, call, configPath, close: async () => { abort.abort(); await done; } };
}

const live = (name = 'ffmpeg') => fakes.live().filter((p) => p.name === name);

test('a malformed request URL gets 400 and the server keeps running', () => withEnv(fakes.env, async () => {
  const s = await open();
  const raw = await new Promise((resolve) => {
    const c = net.createConnection({ host: '127.0.0.1', port: s.url.port }, () => c.write(`GET //% HTTP/1.1\r\nHost: 127.0.0.1:${s.url.port}\r\n\r\n`));
    let buf = '';
    c.on('data', (d) => { buf += d; c.end(); });
    c.on('close', () => resolve(buf));
  });
  assert.match(raw, /^HTTP\/1.1 400/);
  assert.equal((await s.call('GET', '/api/state')).status, 200);
  await s.close();
}));

test('requests without the token are refused', () => withEnv(fakes.env, async () => {
  const s = await open();
  const r = await fetch(new URL('/api/state', s.url));
  assert.equal(r.status, 403);
  await s.close();
}));

test('concurrent preview starts leave one camera session, and closing releases it', () => withEnv(fakes.env, async () => {
  const s = await open();
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => s.call('POST', '/api/preview/start', { profile: ANDROID_PROFILE })));
  const ok = [a, b, c].filter((r) => r.status === 200);
  assert.ok(ok.length >= 1, JSON.stringify([a, b, c]));
  assert.equal(live().length, 1, 'exactly one ffmpeg holds the camera');
  assert.equal((await s.call('GET', '/api/preview/stats')).body.id, c.body.id, 'the newest request wins');
  await s.close();
  assert.equal(live().length, 0);
}));

test('closing while a preview is still opening waits for it and releases it', () => withEnv(fakes.env, async () => {
  fakes.tunnel.mode = 'delay'; fakes.tunnel.delayMs = 400;
  try {
    const s = await open();
    const pending = s.call('POST', '/api/preview/start', { profile: ANDROID_PROFILE }).catch(() => null);
    await waitFor(() => live().length === 1, 3000, 'ffmpeg to spawn');
    await s.close();
    await pending;
    assert.equal(live().length, 0);
  } finally { fakes.tunnel.mode = 'stream'; }
}));

test('a preview nobody watches releases the camera (closed tab)', () => withEnv(fakes.env, async () => {
  const s = await open({ idleReleaseMs: 300 });
  const { body } = await s.call('POST', '/api/preview/start', { profile: ANDROID_PROFILE });
  // A tab watching the stream keeps it open past the grace period.
  const req = http.get(new URL(`/stream?id=${body.id}&t=${s.token}`, s.url));
  const res = await new Promise((r) => req.on('response', r));
  res.resume();
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(live().length, 1);
  req.destroy(); // the tab closes
  await waitFor(() => live().length === 0, 3000, 'the camera to be released');
  assert.equal((await s.call('GET', '/api/preview/stats')).body.id, null);
  await s.close();
}));

test('confirming saves a still only from a preview showing the confirmed settings', () => withEnv(fakes.env, async () => {
  const s = await open();
  const { body } = await s.call('POST', '/api/preview/start', { profile: ANDROID_PROFILE });
  await waitFor(async () => (await s.call('GET', '/api/preview/stats')).body.frames > 0, 3000, 'frames');
  assert.ok(body.id);

  // Rotation changed in the page, preview not restarted yet: the still would show the old framing.
  const stale = await s.call('POST', '/api/save', { name: 'rotated', profile: { ...ANDROID_PROFILE, rotate: 90 }, makeDefault: true });
  assert.equal(stale.status, 409);
  assert.equal(existsSync(join(s.configPath, '..', 'snapshots', 'rotated.jpg')), false);

  const crop = { x: 0.25, y: 0.25, w: 0.5, h: 0.25 };
  const good = await s.call('POST', '/api/save', { name: 'framed', profile: { ...ANDROID_PROFILE, crop }, makeDefault: true });
  assert.equal(good.status, 200, JSON.stringify(good.body));
  assert.ok(existsSync(good.body.snapshot));
  const state = (await s.call('GET', '/api/state')).body;
  assert.deepEqual(state.config.profiles.framed.crop, crop);
  assert.equal(state.config.profiles.rotated, undefined);
  await s.close();
}));
