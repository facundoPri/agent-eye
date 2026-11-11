import test from 'node:test';
import assert from 'node:assert/strict';
import { camera3aCollector, parse3aLine, summarize3a } from '../src/camera3a.js';

const line = (o) => '[server] INFO: agent-eye-3a: ' + Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ');
const auto = { af_mode: 3, af_state: 2, lens_state: 0, ae_state: 2, ae_lock: false, awb_state: 2, awb_lock: false, exposure_ns: 8000000, iso: 400 };

/** A collector fed with reports 500 ms apart, starting at t=1000. */
function collect(reports, extra = []) {
  let t = 1000;
  const c = camera3aCollector(() => t);
  for (const l of extra) c.push(l + '\n');
  for (const r of reports) { c.push(line(r) + '\n'); t += 500; }
  return c;
}

test('parses reports, events and ignores other lines', () => {
  assert.deepEqual(parse3aLine(line({ focus: 2.01, af_mode: 0, ae_lock: true })), { report: { focus: 2.01, af_mode: 0, ae_lock: true } });
  assert.deepEqual(parse3aLine('[server] INFO: agent-eye-3a: locked ae=true awb=false'), { event: 'locked' });
  assert.deepEqual(parse3aLine('[server] WARN: agent-eye-3a: unsupported=focus (this camera has no manual focus)'), { event: 'unsupported', what: 'focus' });
  assert.equal(parse3aLine('[server] INFO: Using camera \'0\''), null);
});

test('the collector joins lines split across chunks', () => {
  const c = camera3aCollector(() => 5);
  const l = line({ focus: 4, af_mode: 3 }) + '\n';
  c.push(l.slice(0, 20)); c.push(l.slice(20, 40)); c.push(l.slice(40));
  assert.deepEqual(c.reports, [{ atMs: 5, focus: 4, af_mode: 3 }]);
});

test('autofocus that moved during the recording is reported as a warning', () => {
  const c = collect([{ ...auto, focus: 4, focus_min: 4, focus_max: 4 }, { ...auto, focus: 3.2, focus_min: 3.2, focus_max: 4.1 }, { ...auto, focus: 4 }]);
  const { camera, warnings } = summarize3a(c, {});
  assert.equal(camera.focus.mode, 'auto');
  assert.deepEqual([camera.focus.minDiopters, camera.focus.maxDiopters], [3.2, 4.1]);
  assert.deepEqual(camera.focus.distanceCm, { nearest: 24.4, farthest: 31.3 });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Autofocus refocused .*31.3 cm and 24.4 cm/);
});

test('steady autofocus gives no warning', () => {
  const c = collect([{ ...auto, focus: 4, focus_min: 3.95, focus_max: 4.05 }, { ...auto, focus: 4 }]);
  assert.deepEqual(summarize3a(c, {}).warnings, []);
});

test('a fixed focus that was held: no warning, even while the lens first travels there', () => {
  const fixed = { ...auto, af_mode: 0, af_state: 0 };
  const c = collect([{ ...fixed, focus: 0.12, focus_min: 0.12, focus_max: 1.5, lens_state: 1 }, { ...fixed, focus: 2.01, focus_min: 1.6, focus_max: 2.01 }, { ...fixed, focus: 2.01, focus_min: 2.01, focus_max: 2.01 }]);
  const { camera, warnings } = summarize3a(c, { focus: 2 });
  assert.equal(camera.focus.mode, 'fixed');
  assert.equal(camera.focus.requested, 2);
  assert.deepEqual(warnings, []);
});

test('a fixed focus that drifted, never arrived, or is unsupported is a warning', () => {
  const fixed = { ...auto, af_mode: 0 };
  const drift = collect([{ ...fixed, focus: 2 }, { ...fixed, focus: 2, focus_min: 1.5, focus_max: 2 }]);
  assert.match(summarize3a(drift, { focus: 2 }).warnings[0], /left the fixed 2 diopters/);
  const never = collect([{ ...fixed, focus: 0.5 }, { ...fixed, focus: 0.5 }]);
  assert.match(summarize3a(never, { focus: 2 }).warnings[0], /did not reach the fixed 2/);
  const none = collect([{ ...auto, focus: 4 }], ['[server] WARN: agent-eye-3a: unsupported=focus (no manual focus)']);
  assert.match(summarize3a(none, { focus: 2 }).warnings[0], /no manual focus/);
});

test('locks: when they engaged is data, not a warning; a missing lock is a warning', () => {
  const c = collect([{ ...auto, focus: 4 }, { ...auto, focus: 4, ae_lock: true, awb_lock: true }], []);
  const { camera, warnings } = summarize3a(c, { exposureLock: true, whiteBalanceLock: true });
  assert.deepEqual(warnings, []);
  assert.equal(camera.exposure.locked, true);
  assert.equal(camera.exposure.lockedAtMs, 1500);
  assert.deepEqual(camera.exposure.exposureMs, { min: 8, max: 8 });
  const notLocked = collect([{ ...auto, focus: 4 }]);
  assert.match(summarize3a(notLocked, { exposureLock: true }).warnings[0], /Exposure was not locked/);
  const unsupported = collect([{ ...auto, focus: 4 }], ['[server] WARN: agent-eye-3a: unsupported=awb_lock']);
  assert.match(summarize3a(unsupported, { whiteBalanceLock: true }).warnings[0], /does not support/);
});

test('only reports inside the recording count; none at all gives null', () => {
  const c = collect([{ ...auto, focus: 1 }, { ...auto, focus: 4 }, { ...auto, focus: 4 }]);
  assert.deepEqual(summarize3a(c, {}, { fromMs: 1400 }).warnings, []);
  assert.equal(summarize3a(c, {}, { fromMs: 9000 }), null);
});

test('the autofocus search when the camera opens is data, not a warning; never settling is a warning', () => {
  const search = { ...auto, af_state: 1, lens_state: 1 };
  const c = collect([{ ...search, focus: 0.12 }, { ...search, focus: 10.9, focus_min: 0.12, focus_max: 10.9 },
    { ...auto, focus: 4.26, focus_min: 0.12, focus_max: 10.9 }, { ...auto, focus: 4.26, focus_min: 4.26, focus_max: 4.26 }]);
  const { camera, warnings } = summarize3a(c, {});
  assert.deepEqual(warnings, []);
  assert.equal(camera.focus.settledAtMs, 2000);
  assert.match(summarize3a(collect([{ ...search, focus: 1 }, { ...search, focus: 3 }]), {}).warnings[0], /never settled/);
});

test('waitReady: focus settled, and the locks on when asked for; false on timeout', async () => {
  const c = camera3aCollector();
  const p = c.waitReady(1000, { locks: true });
  c.push(line({ focus: 4, af_mode: 3, af_state: 1 }) + '\n');
  c.push(line({ focus: 4, af_mode: 3, af_state: 2 }) + '\n');
  let done = false; p.then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(done, false, 'not ready before the lock');
  c.push('[server] INFO: agent-eye-3a: locked ae=true awb=true\n');
  assert.equal(await p, true);
  const fixed = camera3aCollector();
  fixed.push(line({ focus: 2, af_mode: 0, lens_state: 0 }) + '\n');
  assert.equal(await fixed.waitReady(1000), true);
  assert.equal(await camera3aCollector().waitReady(20), false);
});
