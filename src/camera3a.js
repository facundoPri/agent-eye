// What the phone camera's focus, exposure and white balance actually did.
// agent-eye's build of the camera server (vendor/NOTICE) prints a line about twice a second:
//   agent-eye-3a: focus=2.01 focus_min=2.01 focus_max=2.01 af_mode=0 af_state=0 lens_state=0 ae_state=3 ae_lock=true ... iso=1594
// plus "set focus=…", "locked ae=… awb=…" and "unsupported=…" events. Focus is in diopters (1/m, 0 = infinity).

const PREFIX = 'agent-eye-3a:';
// More than this many diopters between the nearest and farthest lens position counts as the focus moving.
// At 25 cm (4 D) it is about 1.5 cm of focus distance.
export const FOCUS_MOVED_D = 0.25;
// A fixed focus counts as held when the lens is within this of the request.
const FOCUS_HELD_D = 0.05;
// CONTROL_AF_STATE values that end a search: PASSIVE_FOCUSED, FOCUSED_LOCKED, PASSIVE_UNFOCUSED.
const AF_SETTLED = new Set([2, 4, 6]);
/** Autofocus has finished searching, or the lens has reached a fixed focus and stopped. */
export const focusSettled = (r) => (r.af_mode === 0 ? r.lens_state === 0 : AF_SETTLED.has(r.af_state));

/** Parse one server log line. Returns null for lines that are not 3A lines. */
export function parse3aLine(line) {
  const i = line.indexOf(PREFIX);
  if (i < 0) return null;
  const rest = line.slice(i + PREFIX.length).trim();
  if (rest.startsWith('locked ')) return { event: 'locked' };
  if (rest.startsWith('set ')) return { event: 'set' };
  const unsupported = rest.match(/^unsupported=(\w+)/);
  if (unsupported) return { event: 'unsupported', what: unsupported[1] };
  const r = {};
  for (const [, k, v] of rest.matchAll(/(\w+)=(\S+)/g)) r[k] = v === 'true' ? true : v === 'false' ? false : Number(v);
  return Object.keys(r).length ? { report: r } : null;
}

/** Collects 3A lines from the server's output (chunks may split lines), stamped with the host clock. */
export function camera3aCollector(now = Date.now) {
  let pending = '';
  const reports = [], unsupported = new Set();
  let lockedAtMs = null;
  const waiters = new Set(); // { test, done }
  return {
    reports, unsupported,
    get lockedAtMs() { return lockedAtMs; },
    push(chunk) {
      const lines = (pending + chunk).split('\n');
      pending = lines.pop().slice(-1000);
      for (const line of lines) {
        const p = parse3aLine(line);
        if (!p) continue;
        if (p.report) reports.push({ atMs: now(), ...p.report });
        else if (p.event === 'unsupported') unsupported.add(p.what);
        else if (p.event === 'locked') lockedAtMs ??= now();
        for (const w of waiters) if (w.test()) w.done(true);
      }
    },
    /**
     * Resolves true once the camera is ready to film: focus settled (autofocus done searching, or the lens
     * at its fixed distance) and, when asked for, the exposure / white balance locks on. False after `ms`.
     */
    waitReady(ms, { locks = false } = {}) {
      const test = () => (!locks || lockedAtMs !== null || unsupported.has('ae_lock') || unsupported.has('awb_lock'))
        && (unsupported.has('focus') || (reports.length > 0 && focusSettled(reports.at(-1))));
      if (test()) return Promise.resolve(true);
      return new Promise((resolve) => {
        const w = { test, done: (v) => { clearTimeout(t); clearTimeout(silent); waiters.delete(w); resolve(v); } };
        const t = setTimeout(() => w.done(false), ms);
        // A server that sends no reports (not agent-eye's build) is not waited for.
        const silent = setTimeout(() => { if (!reports.length) w.done(false); }, Math.min(ms, 1000));
        waiters.add(w);
      });
    },
    latest: () => reports.at(-1) ?? null,
  };
}

const round = (v, d = 3) => (v === undefined || v === null ? null : Math.round(v * 10 ** d) / 10 ** d);
const cm = (diopters) => (diopters > 0 ? Math.round(100 / diopters * 10) / 10 : null); // null = infinity
const range = (vals) => (vals.length ? { min: Math.min(...vals), max: Math.max(...vals) } : null);

/**
 * Summary of the reports that fall in [fromMs, toMs], and warnings for the recording summary.
 * Returns null when the server sent no reports (nothing is known about the camera).
 */
export function summarize3a(collector, profile, { fromMs = -Infinity, toMs = Infinity } = {}) {
  const rs = collector.reports.filter((r) => r.atMs >= fromMs && r.atMs <= toMs);
  if (!rs.length) return null;
  const warnings = [];
  const fixed = profile.focus !== undefined;
  const lows = rs.map((r) => r.focus_min ?? r.focus).filter(Number.isFinite);
  const highs = rs.map((r) => r.focus_max ?? r.focus).filter(Number.isFinite);
  const focusRange = lows.length ? { min: Math.min(...lows), max: Math.max(...highs) } : null;

  const focus = { mode: fixed ? 'fixed' : 'auto', ...(fixed && { requested: profile.focus }) };
  if (focusRange) {
    Object.assign(focus, { minDiopters: round(focusRange.min), maxDiopters: round(focusRange.max),
      distanceCm: { nearest: cm(focusRange.max), farthest: cm(focusRange.min) } });
  }
  if (fixed) {
    if (collector.unsupported.has('focus')) warnings.push('Focus was not fixed: this camera has no manual focus, so autofocus stayed on.');
    else if (focusRange) {
      // The lens takes a moment to reach the requested position after the camera opens.
      const held = rs.findIndex((r) => r.af_mode === 0 && Math.abs(r.focus - profile.focus) <= FOCUS_HELD_D);
      const after = held < 0 ? [] : rs.slice(held + 1);
      const drift = after.filter((r) => r.af_mode !== 0 || Math.abs((r.focus_min ?? r.focus) - profile.focus) > FOCUS_HELD_D
        || Math.abs((r.focus_max ?? r.focus) - profile.focus) > FOCUS_HELD_D);
      if (held < 0) warnings.push(`Focus did not reach the fixed ${profile.focus} diopters (the lens was at ${round(focusRange.min, 2)}-${round(focusRange.max, 2)}).`);
      else if (drift.length) warnings.push(`Focus left the fixed ${profile.focus} diopters during the recording (lens between ${round(focusRange.min, 2)} and ${round(focusRange.max, 2)}).`);
    }
  } else if (focusRange) {
    // Autofocus searches for about 1.5 s when the camera opens: the start of the file is out of focus until
    // settledAtMs. Moving again after that (a flashing screen, a hand) is what blurs frames mid-recording.
    const settled = rs.findIndex(focusSettled);
    if (settled < 0) warnings.push('Autofocus never settled during the recording: frames may be blurred. '
      + 'Fix the focus in the profile ("focus", or Focus: Fixed in `agent-eye preview`).');
    else {
      if (settled > 0) focus.settledAtMs = rs[settled].atMs;
      const after = rs.slice(settled + 1);
      const lo = Math.min(rs[settled].focus, ...after.map((r) => r.focus_min ?? r.focus));
      const hi = Math.max(rs[settled].focus, ...after.map((r) => r.focus_max ?? r.focus));
      if (hi - lo > FOCUS_MOVED_D) {
        const far = cm(lo), near = cm(hi);
        warnings.push(`Autofocus refocused during the recording (between ${far === null ? 'infinity' : `${far} cm`} and ${near} cm): frames may be blurred. `
          + 'Fix the focus in the profile ("focus", or Focus: Fixed in `agent-eye preview`).');
      }
    }
  }

  const exposure = { locked: false };
  const wb = { locked: false };
  for (const [want, key, name, out, unsupportedKey] of [
    [profile.exposureLock, 'ae_lock', 'Exposure', exposure, 'ae_lock'],
    [profile.whiteBalanceLock, 'awb_lock', 'White balance', wb, 'awb_lock']]) {
    out.locked = rs.length > 0 && rs.at(-1)[key] === true;
    if (!want) continue;
    if (collector.unsupported.has(unsupportedKey)) warnings.push(`${name} was not locked: this camera does not support it.`);
    else if (!out.locked) warnings.push(`${name} was not locked by the end of the recording.`);
    // Locks engage about 1.5 s after the camera opens (once the scene is metered): before that the
    // picture can still adjust. Host clock, like startedAtMs.
    else out.lockedAtMs = collector.lockedAtMs ?? rs.find((r) => r[key] === true).atMs;
  }
  const exp = range(rs.map((r) => r.exposure_ns).filter(Number.isFinite));
  const iso = range(rs.map((r) => r.iso).filter(Number.isFinite));
  if (exp) exposure.exposureMs = { min: round(exp.min / 1e6, 3), max: round(exp.max / 1e6, 3) };
  if (iso) exposure.iso = iso;

  return { camera: { focus, exposure, whiteBalance: wb, reports: rs.length }, warnings };
}
