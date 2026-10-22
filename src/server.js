import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProfile, loadConfig, normalizeProfile, saveConfig, emptyConfig, upsertProfile } from './config.js';
import { listDevices, macCameraModes, resolveMacIndex } from './devices.js';
import { assertSupported } from './validate.js';
import { previewOutputArgs } from './ffargs.js';
import { JpegSplitter } from './mjpeg.js';
import { startSession } from './session.js';
import { cropJpeg } from './capture.js';
import { UserError } from './util.js';
import { installSkill, skillStatus } from './skill.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const BOUNDARY = 'agenteyeframe';

function sameToken(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 1e6) throw new UserError('Request too large'); chunks.push(c); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

const conflict = (message) => Object.assign(new UserError(message), { status: 409 });
// Settings that change the picture: a confirmation still must come from a preview opened with all of them.
const IMAGE_KEYS = ['source', 'width', 'height', 'fps', 'zoom', 'rotate'];

/**
 * Local web UI for configuring and previewing a camera.
 * Bound to 127.0.0.1; every request needs a random token and a local Host header,
 * so other web pages cannot reach the camera through the browser.
 * The camera is released when no tab has watched the preview for `idleReleaseMs` (a closed tab).
 */
export async function serveConfigurator({ configPath, projectRoot, mode, profileName, port = 0, onReady, signal, idleReleaseMs = 10000 }) {
  const token = randomBytes(18).toString('base64url');
  let cfg = loadConfig(configPath) ?? emptyConfig();
  let preview = null; // { id, session, latest, frames, clients, startedAt, profile, idleTimer }
  let deviceCache = null;
  // Preview changes run one at a time, so two quick requests cannot both open the camera;
  // a request that a newer one overtook while waiting is dropped.
  let queue = Promise.resolve(), latestRequest = 0, closing = false;
  const serial = (fn) => { const r = queue.then(fn); queue = r.catch(() => {}); return r; };
  let finish;
  const finished = new Promise((r) => { finish = r; });
  signal?.addEventListener('abort', () => finish('signal'), { once: true });

  const stopPreview = async () => {
    const p = preview; preview = null;
    if (p) { clearTimeout(p.idleTimer); for (const c of p.clients) c.end(); await p.session.stop().catch(() => {}); }
  };

  const releaseWhenUnwatched = (state) => {
    clearTimeout(state.idleTimer);
    if (state.clients.size) return;
    state.idleTimer = setTimeout(() => serial(async () => {
      if (preview === state && !state.clients.size) await stopPreview();
    }), idleReleaseMs);
  };

  function startPreview(input) {
    const profile = normalizeProfile(input);
    const request = ++latestRequest;
    return serial(async () => {
      if (closing) throw new UserError('The page is closing.');
      if (request !== latestRequest) throw conflict('A newer preview request replaced this one.');
      await stopPreview();
      return openPreview(profile);
    });
  }

  async function openPreview(profile) {
    const state = { id: randomBytes(6).toString('hex'), latest: null, frames: 0, clients: new Set(), profile, startedAt: Date.now() };
    const splitter = new JpegSplitter((frame) => {
      state.latest = Buffer.from(frame); state.frames += 1;
      const head = Buffer.from(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
      for (const res of state.clients) {
        if (res.writableNeedDrain) continue; // a slow tab drops frames instead of lagging behind
        res.write(head); res.write(frame); res.write('\r\n');
      }
    });
    state.session = await startSession(profile, previewOutputArgs(profile, { width: 960, fps: 15, quality: 6, applyCrop: false }), { onStdout: (d) => splitter.push(d) });
    state.session.closed.then(() => { if (preview === state) { clearTimeout(state.idleTimer); for (const c of state.clients) c.end(); preview = null; } });
    preview = state;
    releaseWhenUnwatched(state);
    return state;
  }
  const stopRequested = () => { latestRequest++; return serial(stopPreview); };

  const route = {
    'GET /api/state': async () => ({ mode, configPath, config: cfg, profileName: profileName ?? cfg.default ?? null,
      profile: profileName || cfg.default ? getProfile(cfg, profileName) : null }),
    'POST /api/devices': async () => { deviceCache = await listDevices({ capabilities: true }); return deviceCache; },
    'POST /api/mac-modes': async (body) => ({ modes: await macCameraModes(await resolveMacIndex(body.source)) }),
    'POST /api/preview/start': async (body) => { const s = await startPreview(body.profile); return { id: s.id }; },
    'POST /api/preview/stop': async () => { await stopRequested(); return { ok: true }; },
    'GET /api/preview/stats': async () => preview ? { id: preview.id, frames: preview.frames, sinceMs: Date.now() - preview.startedAt,
      fps: preview.frames / Math.max((Date.now() - preview.startedAt) / 1000, 0.001) } : { id: null, frames: 0, fps: 0 },
    'POST /api/save': async (body) => {
      const profile = normalizeProfile(body.profile);
      if (!deviceCache) deviceCache = await listDevices({ capabilities: true });
      const dev = deviceCache.devices.find((d) => d.id === profile.source);
      if (dev) assertSupported(profile, dev, dev.kind === 'mac' ? (await macCameraModes(dev.index)) : []);
      // The still saved with the profile is what the person approved, so it must show these exact settings.
      const shown = preview;
      if (!shown?.latest || !IMAGE_KEYS.every((k) => shown.profile[k] === profile[k])) {
        throw conflict('The preview has not caught up with these settings yet. Confirm again once the new image shows.');
      }
      const still = await cropJpeg(shown.latest, profile.crop);
      cfg = upsertProfile(cfg, body.name, profile, { makeDefault: !!body.makeDefault });
      saveConfig(configPath, cfg);
      const dir = join(dirname(configPath), 'snapshots');
      mkdirSync(dir, { recursive: true });
      const snapshot = join(dir, `${body.name}.jpg`);
      writeFileSync(snapshot, still);
      return { ok: true, name: body.name, configPath, snapshot };
    },
    'GET /api/skill': async () => skillStatus(projectRoot),
    'POST /api/skill/install': async () => installSkill(projectRoot),
    'POST /api/done': async () => { setTimeout(() => finish('done'), 100); return { ok: true }; },
  };

  const server = http.createServer(async (req, res) => {
    const host = req.headers.host ?? '';
    const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
    try {
      let url;
      try { url = new URL(req.url, 'http://x'); } catch { return send(400, '{"error":"bad request"}'); }
      if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return send(403, '{"error":"bad host"}');
      const t = url.searchParams.get('t') ?? req.headers['x-agent-eye-token'] ?? '';
      if (!sameToken(t, token)) return send(403, '{"error":"missing or wrong token"}');

      if (req.method === 'GET' && url.pathname === '/') {
        return send(200, readFileSync(join(WEB, 'index.html'), 'utf8').replace('__TOKEN__', token), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/stream') {
        if (!preview || preview.id !== url.searchParams.get('id')) return send(404, '{"error":"no such preview"}');
        const state = preview;
        res.writeHead(200, { 'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`, 'Cache-Control': 'no-store', Connection: 'close' });
        state.clients.add(res);
        clearTimeout(state.idleTimer);
        req.on('close', () => { state.clients.delete(res); if (preview === state) releaseWhenUnwatched(state); });
        return;
      }
      if (req.method === 'POST' && !/application\/json/.test(req.headers['content-type'] ?? '')) return send(415, '{"error":"JSON only"}');
      const handler = route[`${req.method} ${url.pathname}`];
      if (!handler) return send(404, '{"error":"not found"}');
      send(200, JSON.stringify(await handler(req.method === 'POST' ? await readJson(req) : {})));
    } catch (e) {
      if (res.headersSent) return res.destroy();
      send(e.status ?? (e instanceof UserError ? 400 : 500), JSON.stringify({ error: e.message, hint: e.hint }));
    }
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/?t=${token}`;
  onReady?.(url);
  await finished;
  closing = true;
  await serial(stopPreview); // also waits for a preview that is still opening
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  return cfg;
}
