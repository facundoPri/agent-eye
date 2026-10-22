// Round trip of the browser page: a saved profile opened and confirmed unchanged must come back unchanged.
// Runs the page's own script in a VM with a minimal DOM (elements built from the ids in index.html).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'index.html'), 'utf8');

function element(tag, attrs) {
  const el = {
    tagName: tag.toUpperCase(), type: attrs.type, min: attrs.min, max: attrs.max, checked: false, disabled: false,
    textContent: '', className: '', style: {}, options: [], listeners: {},
    classes: new Set(),
    classList: { toggle(c, on) { (on ?? !el.classes.has(c)) ? el.classes.add(c) : el.classes.delete(c); }, add(c) { el.classes.add(c); }, remove(c) { el.classes.delete(c); } },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    removeAttribute() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 600 }),
    appendChild(o) { this.options.push(o); },
    set innerHTML(_) { this.options = []; this._value = undefined; },
  };
  let value = attrs.value ?? '';
  Object.defineProperty(el, 'value', {
    get() {
      if (el.tagName === 'SELECT') return el.options.some((o) => o.value === el._value) ? el._value : el.options[0]?.value ?? '';
      return value;
    },
    set(v) {
      if (el.tagName === 'SELECT') { if (el.options.some((o) => o.value === String(v))) el._value = String(v); return; }
      if (el.type === 'range') v = Math.min(Math.max(Number(v), Number(el.min)), Number(el.max)); // browsers clamp ranges
      value = String(v);
    },
  });
  return el;
}

const DEVICE = { id: 'android:FAKE1/0', kind: 'android', name: 'Fake (back)',
  caps: { sizes: ['1920x1080', '1280x720'], fps: [15, 30, 60], highSpeed: [{ size: '1280x720', fps: [120, 240] }], zoomRange: [1, 8] } };

/** Load the page with `saved` as the current profile; returns { page, saves, $ }. */
async function openPage(saved) {
  const els = {};
  for (const m of HTML.matchAll(/<(\w+)([^>]*?)\sid="(\w+)"([^>]*)>/g)) {
    const attrs = Object.fromEntries([...(m[2] + m[4]).matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
    els[m[3]] = element(m[1], attrs);
  }
  for (const m of HTML.matchAll(/<select id="(\w+)">([\s\S]*?)<\/select>/g)) {
    for (const o of m[2].matchAll(/<option value="([^"]*)">/g)) els[m[1]].appendChild({ value: o[1] });
  }
  const saves = [], starts = [], calls = [], ticks = [], docListeners = {};
  const server = { previewId: 'p1', startError: null, saveError: null }; // what /api/preview/stats reports, and failures to inject
  const fail = (status, error) => { throw Object.assign(new Error(error), { status }); };
  const replies = {
    'GET /api/state': () => ({ mode: 'preview', profileName: 'default', profile: { name: 'default', ...saved } }),
    'POST /api/devices': () => ({ devices: [DEVICE], problems: [] }),
    'POST /api/preview/start': () => { if (server.startError) fail(400, server.startError); starts.push(1); return { id: server.previewId }; },
    'POST /api/preview/stop': () => ({ ok: true }),
    'POST /api/done': () => ({ ok: true }),
    'GET /api/preview/stats': () => ({ id: server.previewId, frames: 5, fps: 15 }),
    'POST /api/save': (b) => { if (server.saveError) fail(409, server.saveError); saves.push(b); return { name: b.name, configPath: '/p/.agent-eye/config.json' }; },
    'GET /api/skill': () => ({ targets: [], upToDate: true, installed: true, projectRoot: '/p' }),
  };
  const fetch = async (path, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    const reply = replies[`${init.method} ${path}`];
    calls.push(path);
    try { const out = reply ? reply(body) : { error: 'nope' }; return { ok: !!reply, status: reply ? 200 : 404, json: async () => out }; }
    catch (e) { return { ok: false, status: e.status, json: async () => ({ error: e.message }) }; }
  };
  const page = vm.createContext({
    fetch, console, Date, Math, JSON, Number, String, Set, Promise,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: (fn) => ticks.push(fn), addEventListener: () => {},
    document: { hidden: false, body: {}, getElementById: (id) => els[id], createElement: (t) => element(t, {}),
      addEventListener: (type, fn) => { docListeners[type] = fn; } },
  });
  vm.runInContext(HTML.match(/<script>([\s\S]*)<\/script>/)[1], page);
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  const confirm = async () => { await els.save.onclick(); return saves.at(-1).profile; };
  return { page, els, confirm, starts, calls, ticks, server, docListeners };
}

const base = { source: DEVICE.id, width: 1920, height: 1080, fps: 30, zoom: 1, crop: { x: 0, y: 0, w: 1, h: 1 }, rotate: 0 };

test('confirming without changes keeps a crop the controls cannot express', async () => {
  for (const crop of [{ x: 0.25, y: 0.25, w: 0.5, h: 0.25 }, { x: 0.4, y: 0.4, w: 0.05, h: 0.05 }, { x: 0.1, y: 0.2, w: 0.3, h: 0.6 }]) {
    const saved = { ...base, crop, rotate: 90, zoom: 2, bitrate: 30 };
    const { confirm } = await openPage(saved);
    assert.deepEqual(await confirm(), saved);
  }
});

test('confirming without changes keeps a frame rate outside the usual menu', async () => {
  const saved = { ...base, fps: 15 };
  const { confirm } = await openPage(saved);
  assert.deepEqual(await confirm(), saved);
});

test('touching the framing controls switches to a crop with the frame proportions', async () => {
  const { els, confirm } = await openPage({ ...base, crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.25 } });
  els.dz.value = 4; els.dz.oninput();
  const { crop } = await confirm();
  assert.equal(crop.w, 0.25);
  assert.equal(crop.h, 0.25);
});

test('a full-frame profile round-trips', async () => {
  const { confirm } = await openPage(base);
  assert.deepEqual(await confirm(), base);
});

test('a preview taken by another tab is not reopened automatically (no tab fight)', async () => {
  const { page, els, starts, ticks, server, docListeners } = await openPage(base);
  vm.runInContext('previewId = "p1"', page); // the debounced start is stubbed; pretend it ran
  server.previewId = 'other-tab';
  for (const tick of ticks) await tick();
  for (const tick of ticks) await tick();
  assert.equal(starts.length, 0, 'the page must wait for the person');
  assert.match(els.msg.textContent, /released/);
  for (const fn of els.msg.listeners.click) fn(); // the person clicks to take it back
  await new Promise((r) => setImmediate(r));
  assert.equal(starts.length, 1);
  assert.equal(typeof docListeners.visibilitychange, 'function');
});

const settle = () => new Promise((r) => setImmediate(r));

test('a save refused with 409 is shown as a warning and can be retried', async () => {
  const { els, server, calls } = await openPage(base);
  server.saveError = 'The preview has not caught up with these settings yet.';
  await els.save.onclick();
  assert.match(els.note.textContent, /not caught up/);
  assert.equal(els.note.className, 'warn');
  assert.equal(els.saved.textContent, '');
  assert.equal(els.save.disabled, false, 'the person can confirm again');
  server.saveError = null;
  await els.save.onclick();
  assert.equal(els.note.textContent, '');
  assert.match(els.saved.textContent, /Saved "default"/);
  assert.equal(calls.filter((c) => c === '/api/save').length, 2);
});

test('a change to the settings clears the saved confirmation', async () => {
  const { els } = await openPage(base);
  await els.save.onclick();
  assert.match(els.saved.textContent, /Saved/);
  els.dz.value = 2; els.dz.oninput();
  assert.equal(els.saved.textContent, '');
});

test('a preview that fails to start can be retried by clicking the message', async () => {
  const { page, els, server, starts } = await openPage(base);
  server.startError = 'The phone camera is in use.';
  await vm.runInContext('restartPreview()', page);
  assert.match(els.msg.textContent, /in use[\s\S]*try again/);
  assert.match(els.msg.className, /\berr\b/);
  server.startError = null;
  for (const fn of els.msg.listeners.click) fn();
  await settle();
  assert.equal(starts.length, 1);
  assert.equal(els.msg.className.includes('err'), false);
});

test('Close stops the preview, releases the camera, and the page stops polling it', async () => {
  const { page, els, calls, ticks } = await openPage(base);
  vm.runInContext('previewId = "p1"', page); // pretend the debounced start ran
  const before = calls.length;
  await els.done.onclick();
  assert.deepEqual(calls.slice(before), ['/api/preview/stop', '/api/done']);
  assert.ok(els.app.classes.has('hidden'));
  assert.ok(els.bye.classes.has('show'));
  for (const tick of ticks) await tick();
  assert.equal(calls.includes('/api/preview/stats'), false, 'no stats poll after Close');
});
