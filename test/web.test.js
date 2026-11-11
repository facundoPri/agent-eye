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

// The phone's switching camera (all lenses), and each lens as a camera of its own, as devices.js lists them.
const LENSES = [{ id: '2', zoom: 0.61, nearest: 40, px: 4080, n: 1, kind: 'ultrawide' }, { id: '0', zoom: 1, nearest: 10, px: 4096, n: 2, kind: 'main' },
  { id: '3', zoom: 2.16, nearest: 2, px: 4032, n: 3, kind: 'telephoto' }];
const CAPS = { sizes: ['1920x1080', '1280x720'], fps: [15, 30, 60], highSpeed: [{ size: '1280x720', fps: [120, 240] }], focusRange: [0, 10], locks: ['ae', 'awb'], afRegions: true, lenses: LENSES };
const DEVICE = { id: 'android:FAKE1/4', kind: 'android', name: 'Fake (back, all lenses)', caps: { ...CAPS, zoomRange: [0.5, 8], lensId: null } };
const LENS_DEVICES = LENSES.map((l) => ({ id: `android:FAKE1/${l.id}`, kind: 'android', name: `Fake (lens ${l.n})`,
  caps: { ...CAPS, zoomRange: [1, l.id === '0' ? 10 : 4], focusRange: [0, l.nearest], lensId: l.id, highSpeed: [] } }));
/** The zoom slider is logarithmic: it holds log2 of the zoom. */
const setZoom = (els, e) => { els.zoom.value = Math.log2(e); els.zoom.oninput(); };

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
  const saves = [], starts = [], calls = [], ticks = [], docListeners = {}, winListeners = {}, lives = [], bodies = {};
  const server = { previewId: 'p1', startError: null, saveError: null, camera: null }; // what /api/preview/stats reports, and failures to inject
  const fail = (status, error) => { throw Object.assign(new Error(error), { status }); };
  const replies = {
    'GET /api/state': () => ({ mode: 'preview', profileName: 'default', profile: { name: 'default', ...saved } }),
    'POST /api/devices': () => ({ devices: [DEVICE, ...LENS_DEVICES], problems: [] }),
    'POST /api/preview/start': () => { if (server.startError) fail(400, server.startError); starts.push(1); return { id: server.previewId }; },
    'POST /api/preview/stop': () => ({ ok: true }),
    'POST /api/done': () => ({ ok: true }),
    'GET /api/preview/stats': () => ({ id: server.previewId, frames: 5, fps: 15, camera: server.camera }),
    'POST /api/preview/live': (b) => { lives.push(b); return { ok: true }; },
    'POST /api/preview/scan': () => ({ focus: 4.26, ok: true }),
    'POST /api/preview/frame': () => server.frameReply,
    'POST /api/save': (b) => { if (server.saveError) fail(409, server.saveError); saves.push(b); return { name: b.name, configPath: '/p/.agent-eye/config.json' }; },
    'GET /api/skill': () => ({ targets: [], upToDate: true, installed: true, projectRoot: '/p' }),
  };
  const fetch = async (path, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    const reply = replies[`${init.method} ${path}`];
    calls.push(path); bodies[path] = body;
    try { const out = reply ? reply(body) : { error: 'nope' }; return { ok: !!reply, status: reply ? 200 : 404, json: async () => out }; }
    catch (e) { return { ok: false, status: e.status, json: async () => ({ error: e.message }) }; }
  };
  const page = vm.createContext({
    fetch, console, Date, Math, JSON, Number, String, Set, Promise,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: (fn) => ticks.push(fn), addEventListener: (type, fn) => { winListeners[type] = fn; },
    document: { hidden: false, body: {}, getElementById: (id) => els[id], createElement: (t) => element(t, {}),
      addEventListener: (type, fn) => { docListeners[type] = fn; } },
  });
  vm.runInContext(HTML.match(/<script>([\s\S]*)<\/script>/)[1], page);
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  const confirm = async () => { await els.save.onclick(); return saves.at(-1).profile; };
  return { page, els, confirm, starts, calls, ticks, server, docListeners, winListeners, lives, bodies };
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

test('touching the zoom moves as much as it can to the camera zoom, the rest a crop with the frame proportions', async () => {
  // a 2x crop centred at (0.5, 0.375): zooming to 4x, the camera zoom stops at 2x to keep that center in the picture
  const { els, confirm } = await openPage({ ...base, crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.25 } });
  setZoom(els, 4);
  const { zoom, crop } = await confirm();
  assert.equal(zoom, 2);
  assert.deepEqual(crop, { x: 0.25, y: 0, w: 0.5, h: 0.5 });
  assert.match(els.zoomParts.textContent, /Camera 2.00× \(lens 2 · main \+ sensor crop 2.0×\) · digital 2.0×\. The camera zoom stops there to keep the center/);
});

test('a centred zoom is all camera zoom', async () => {
  const { els, confirm } = await openPage(base);
  setZoom(els, 3);
  const p = await confirm();
  assert.equal(p.zoom, 3);
  assert.deepEqual(p.crop, { x: 0, y: 0, w: 1, h: 1 });
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
  setZoom(els, 2);
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

test('a fixed focus and 3A locks round-trip', async () => {
  const saved = { ...base, focus: 4.25, exposureLock: true, whiteBalanceLock: true };
  const { confirm } = await openPage(saved);
  assert.deepEqual(await confirm(), saved);
});

test('"Focus on frame" scans the focus area and fixes the focus there', async () => {
  const { page, els, confirm, bodies } = await openPage({ ...base, focusRegion: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 } });
  vm.runInContext('previewId = "p1"; updateLens()', page);
  assert.equal(els.focusHere.disabled, false);
  await els.focusHere.onclick();
  assert.deepEqual(bodies['/api/preview/scan'], { region: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 } });
  assert.equal(els.focusMode.value, 'fixed');
  assert.match(els.frameNote.textContent, /Focus fixed at 23 cm/);
  const p = await confirm();
  assert.equal(p.focus, 4.26);
  assert.deepEqual(p.focusRegion, { x: 0.4, y: 0.4, w: 0.2, h: 0.2 });
});

test('zoom, focus and locks change the running camera live, without restarting it', async () => {
  const { page, els, starts, lives } = await openPage(base);
  vm.runInContext('previewId = "p1"', page);
  setZoom(els, 2.5);
  els.focusMode.value = 'fixed'; els.focus.value = 1; els.focus.oninput(); // 1 m: every lens reaches it
  els.aeLock.checked = true; els.aeLock.oninput();
  for (let i = 0; i < 5; i++) await settle();
  assert.equal(starts.length, 0, 'no restart, so no blink');
  const sent = Object.assign({}, ...lives);
  assert.equal(sent.zoom, 2.5); assert.equal(sent.focus, 1); assert.equal(sent.exposureLock, true);
});

test('one zoom; the breakdown says which lens is used and how much is a crop on its sensor or digital', async () => {
  const { page, els } = await openPage(base);
  setZoom(els, 1);
  assert.equal(els.zoomV.textContent, '1.00×');
  assert.match(els.zoomParts.textContent, /Camera 1.00× \(lens 2 · main, optical\) · digital 1.0×/);
  setZoom(els, 1.8);
  assert.match(els.zoomParts.textContent, /1.80× \(lens 2 · main \+ sensor crop 1.8×\)/);
  vm.runInContext('liveLens = "3"', page); setZoom(els, 4.32);
  assert.match(els.zoomParts.textContent, /4.32× \(lens 3 · telephoto \+ sensor crop 2.0×\)/);
  assert.equal(els.lensStat.textContent, 'lens 3 · telephoto (auto)');
  assert.deepEqual(els.lensBar.options.map((b) => b.textContent), ['Auto', '1 · ultrawide 0.61×', '2 · main 1×', '3 · telephoto 2.16× ●']);
  assert.equal(els.lensBar.options[0].className, 'on');
});

test('choosing a lens opens that lens as the camera and keeps the zoom and the center', async () => {
  const { els, confirm } = await openPage(base);
  setZoom(els, 4.32);
  els.lensBar.options[3].onclick(); // lens 3, telephoto 2.16x
  assert.equal(els.camera.value, 'android:FAKE1/3');
  assert.equal(els.zoomV.textContent, '4.32×');
  const p = await confirm();
  assert.equal(p.source, 'android:FAKE1/3');
  assert.equal(p.zoom, 2); // 4.32x of the main lens's view = 2x of the telephoto's own
  assert.match(els.zoomParts.textContent, /Camera 2.00× \(lens 3 · telephoto \+ sensor crop 2.0×\)/);
  assert.equal(els.lensStat.textContent, 'lens 3 · telephoto');
});

test('a fixed focus closer than a lens can reach keeps the camera zoom below that lens', async () => {
  const { els, confirm } = await openPage({ ...base, focus: 4 }); // 25 cm; the telephoto focuses from 50 cm
  setZoom(els, 4);
  const p = await confirm();
  assert.equal(p.zoom, 1.9);
  assert.equal(p.crop.w, 0.475);
  assert.match(els.zoomParts.textContent, /stays below the lens that cannot focus at 25 cm/);
});

test('the zoom keeps the framed part of the scene: the crop and focus area follow it', async () => {
  const { els, confirm } = await openPage({ ...base, crop: { x: 0.375, y: 0.375, w: 0.25, h: 0.25 }, focusRegion: { x: 0.45, y: 0.45, w: 0.1, h: 0.1 } });
  setZoom(els, 4); // the same 4x, now all camera zoom since it is centred
  const p = await confirm();
  assert.equal(p.zoom, 4);
  assert.deepEqual(p.crop, { x: 0, y: 0, w: 1, h: 1 });
  assert.deepEqual(p.focusRegion, { x: 0.3, y: 0.3, w: 0.4, h: 0.4 });
});

test('dragging on the preview frames the selection with the camera zoom, a crop and the focus', async () => {
  const { page, els, winListeners, bodies, server, confirm } = await openPage(base);
  vm.runInContext('previewId = "p1"', page);
  server.frameReply = { changes: { zoom: 1.91, crop: { x: 0.3716, y: 0.3716, w: 0.2567, h: 0.2567 }, focusRegion: { x: 0.4, y: 0.39, w: 0.19, h: 0.23 }, focus: 4.26 },
    lens: { id: '0', zoom: 1, nearest: 10 }, digitalCrop: 3.9, notes: ['The telephoto lens cannot focus closer than 50 cm…'],
    ranking: { best: '3', inUse: '0', lenses: [{ id: '3', n: 3, kind: 'telephoto', detailPx: 830, why: 'cannot focus at 23 cm' }, { id: '0', n: 2, kind: 'main', detailPx: 410 }] } };
  const ev = (x, y) => ({ button: 0, clientX: x, clientY: y, preventDefault() {} });
  for (const fn of els.view.listeners.mousedown) fn(ev(450, 264));
  winListeners.mousemove(ev(550, 336));
  assert.equal(els.sel.style.display, 'block');
  await winListeners.mouseup();
  for (let i = 0; i < 5; i++) await settle();
  assert.deepEqual(bodies['/api/preview/frame'], { selection: { x: 0.45, y: 0.44, w: 0.1, h: 0.12 } });
  assert.match(els.frameNote.textContent, /Focus 23 cm[\s\S]*telephoto lens cannot focus[\s\S]*lens 3 telephoto: cannot focus at 23 cm; lens 2 main: 410 px across/);
  assert.match(els.zoomParts.textContent, /Camera 1.91× \(lens 2 · main \+ sensor crop 1.9×\) · digital 3.9×/);
  assert.equal(els.bestRow.classes.has('hidden'), false);
  assert.match(els.useBest.textContent, /Use lens 3 \(telephoto\)/);
  for (const fn of els.view.listeners.click) fn(ev(550, 336)); // the click that ends a drag does not re-center
  const p = await confirm();
  assert.equal(p.zoom, 1.91); assert.equal(p.focus, 4.26);
  assert.deepEqual(p.crop, { x: 0.3716, y: 0.3716, w: 0.2567, h: 0.2567 });
  assert.deepEqual(p.focusRegion, { x: 0.4, y: 0.39, w: 0.19, h: 0.23 });
});

test('"Use lens N" switches to the lens with more detail and frames the same part of the scene on it', async () => {
  const { page, els, winListeners, bodies, server, confirm } = await openPage(base);
  vm.runInContext('previewId = "p1"', page);
  server.frameReply = { changes: { zoom: 2, crop: { x: 0.375, y: 0.375, w: 0.25, h: 0.25 } }, lens: { id: '0' }, digitalCrop: 4, notes: [],
    ranking: { best: '3', inUse: '0', lenses: [] } };
  const ev = (x, y) => ({ button: 0, clientX: x, clientY: y, preventDefault() {} });
  for (const fn of els.view.listeners.mousedown) fn(ev(450, 270));
  winListeners.mousemove(ev(550, 330));
  await winListeners.mouseup();
  for (let i = 0; i < 5; i++) await settle();
  const first = bodies['/api/preview/frame'].selection;
  server.frameReply = { changes: { zoom: 3, crop: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 } }, lens: { id: '3' }, digitalCrop: 5, notes: [] };
  els.useBest.onclick();
  assert.equal(els.camera.value, 'android:FAKE1/3');
  await vm.runInContext('restartPreview()', page);
  for (let i = 0; i < 5; i++) await settle();
  const again = bodies['/api/preview/frame'].selection;
  assert.notDeepEqual(again, first);
  assert.ok(Math.abs(again.x + again.w / 2 - 0.5) < 0.02, 'still centred on the same spot');
  const p = await confirm();
  assert.equal(p.source, 'android:FAKE1/3'); assert.equal(p.zoom, 3);
});

test('choosing a lens that cannot focus as close warns, and the focus asked for comes back on a lens that can', async () => {
  const { els } = await openPage({ ...base, focus: 3.7 }); // 27 cm
  els.lensBar.options[3].onclick(); // telephoto: focuses from 50 cm (2 D)
  assert.equal(+els.focus.value, 2);
  assert.match(els.lensWarn.textContent, /Lens 3 \(telephoto\) cannot focus closer than 50 cm, and the subject is at 27 cm/);
  els.lensBar.options[2].onclick(); // main
  assert.equal(+els.focus.value, 3.7);
  assert.equal(els.lensWarn.textContent, '');
});

test('a warning appears when the lens in use cannot focus as close as the fixed focus', async () => {
  const { page, els } = await openPage({ ...base, focus: 3.7 });
  assert.equal(els.lensWarn.textContent, '');
  vm.runInContext('liveLens = "3"', page); setZoom(els, 2.21);
  assert.match(els.lensWarn.textContent, /Lens 3 \(telephoto\) cannot focus closer than 50 cm, and the subject is at 27 cm/);
  vm.runInContext('liveLens = "0"', page); setZoom(els, 1);
  assert.equal(els.lensWarn.textContent, '');
});
