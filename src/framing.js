// Framing a selection: as much of the phone's own zoom as possible, a centred crop for the rest, and the
// focus measured on the selection. Pure geometry first, then the steps run against a live camera session.
//
// Coordinates. "view": fractions of the picture the person sees before the crop: the camera image at the
// profile's zoom, after the rotation (the crop and focusRegion of a profile are in view coordinates).
// "camera": the same picture before the rotation (what the phone's camera server works with).
// The phone's zoom is centred on the sensor, so changing it from z0 to z1 maps p -> 0.5 + (p - 0.5) * z1 / z0.

import { FULL_CROP } from './config.js';

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const r4 = (v) => Math.round(v * 10000) / 10000;

/** A view rectangle as the camera sees it (undo agent-eye's rotation, which is applied on the Mac). */
export function viewToCamera({ x, y, w, h }, rotate = 0) {
  switch (rotate) {
    case 90: return { x: y, y: 1 - x - w, w: h, h: w }; // ffmpeg transpose=1, clockwise
    case 180: return { x: 1 - x - w, y: 1 - y - h, w, h };
    case 270: return { x: 1 - y - h, y: x, w: h, h: w }; // transpose=2, counter-clockwise
    default: return { x, y, w, h };
  }
}

/** A camera rectangle in view coordinates (agent-eye's rotation applied): the inverse of viewToCamera. */
export function cameraToView(r, rotate = 0) {
  return viewToCamera(r, { 90: 270, 270: 90 }[rotate] ?? rotate);
}

/** A rectangle in the view at zoom z0, in the view at zoom z1. */
export function rezoom({ x, y, w, h }, z0, z1) {
  const k = z1 / z0;
  return { x: 0.5 + (x - 0.5) * k, y: 0.5 + (y - 0.5) * k, w: w * k, h: h * k };
}

/** A rectangle given in fractions of the cropped picture (what `snapshot` shows), in view coordinates. */
export function pictureToView(r, crop = FULL_CROP) {
  return { x: crop.x + r.x * crop.w, y: crop.y + r.y * crop.h, w: r.w * crop.w, h: r.h * crop.h };
}

/** The lens a logical multi-camera uses at zoom z: the one with the largest zoom not above z (measured on a Motorola edge 40 pro). */
export function lensAt(lenses, z) {
  if (!lenses?.length) return null;
  const sorted = [...lenses].sort((a, b) => a.zoom - b.zoom);
  return [...sorted].reverse().find((l) => l.zoom <= z + 0.01) ?? sorted[0];
}

/** Name a lens by its zoom: ultrawide below 1x, main around 1x, telephoto above. */
export const lensName = (l) => (!l ? 'main' : l.zoom < 0.9 ? 'ultrawide' : l.zoom <= 1.2 ? 'main' : 'telephoto');

/**
 * Largest camera zoom at which `sel` (view at zoom z0), grown by `margin` of its size on each side,
 * still fits a crop with the picture's proportions centred on it. Not clamped to the camera's range.
 */
export function maxCenteredZoom(sel, z0, margin = 0.06) {
  const s1 = rezoom(sel, z0, 1);
  const side = Math.max(s1.w, s1.h) * (1 + 2 * margin); // with the frame's proportions, w = h in fractions
  const cx = s1.x + s1.w / 2, cy = s1.y + s1.h / 2;
  return 0.5 / (Math.max(Math.abs(cx - 0.5), Math.abs(cy - 0.5)) + side / 2);
}

/** The crop (view at zoom z) with the picture's proportions, centred on `sel` (view at z0), kept inside the frame. */
export function centeredCrop(sel, z0, z, margin = 0.06) {
  const s = rezoom(sel, z0, z);
  const side = Math.min(1, Math.max(s.w, s.h) * (1 + 2 * margin));
  if (side >= 0.999) return { ...FULL_CROP };
  const x = clamp(s.x + s.w / 2 - side / 2, 0, 1 - side), y = clamp(s.y + s.h / 2 - side / 2, 0, 1 - side);
  return { x: r4(x), y: r4(y), w: r4(side), h: r4(side) };
}

/**
 * Plan the zoom for a selection: the largest camera zoom that keeps it centred, within the camera's range,
 * below the lens in `avoid` (lenses that could not focus on the subject). Returns { zoom, lens, limitedBy }.
 */
export function planZoom(sel, z0, { zoomRange = [1, 1], lenses = null, avoid = [] } = {}) {
  const geometric = maxCenteredZoom(sel, z0);
  let zoom = clamp(geometric, zoomRange[0], zoomRange[1]);
  let limitedBy = geometric < zoomRange[0] ? 'selection' : geometric > zoomRange[1] ? 'range' : 'centre';
  for (const id of avoid) {
    const l = lenses?.find((x) => x.id === id);
    if (l && zoom >= l.zoom - 0.01) { zoom = Math.max(zoomRange[0], l.zoom - 0.05); limitedBy = 'focus'; }
  }
  return { zoom: Math.round(zoom * 100) / 100, lens: lensAt(lenses, zoom), limitedBy };
}

const cm = (d) => (d > 0 ? Math.round(100 / d) : null);

/** How much a camera's 1x view is zoomed compared with the main lens: a lens opened on its own starts at its zoom. */
export function baseZoom(caps) {
  const own = caps.lensId != null && caps.lenses?.find((l) => l.id === caps.lensId);
  return own ? own.zoom : 1;
}

/**
 * Which lens shows `selEq` (camera coordinates of the main lens's 1x view) with the most detail: the pixels of
 * its sensor across the subject, among the lenses whose view holds the subject and that can focus on it.
 * `subject`: { focus (diopters), atLimit (the measuring lens was at its nearest focus, so the subject may be
 * nearer) } or null when unknown. Returns the lenses with { detailPx, fits, focusOk, why } and the best one.
 */
export function rankLenses(selEq, subject, lenses, measuredWith = null) {
  const ranked = (lenses ?? []).map((l) => {
    const s = rezoom(selEq, 1, l.zoom);
    const fits = s.x >= -0.001 && s.y >= -0.001 && s.x + s.w <= 1.001 && s.y + s.h <= 1.001;
    let focusOk = null;
    if (subject && l.nearest > 0) {
      focusOk = subject.atLimit ? l.nearest > (measuredWith?.nearest ?? 0) + 0.05 : l.nearest >= subject.focus - 0.05;
    }
    const why = !fits ? 'the subject does not fit in its view'
      : focusOk === false ? `it focuses from ${cm(l.nearest)} cm and the subject is nearer` : null;
    return { id: l.id, n: l.n, kind: l.kind ?? lensName(l), zoom: l.zoom, detailPx: Math.round(selEq.w * l.zoom * (l.px || 0)), fits, focusOk, why };
  });
  const usable = ranked.filter((r) => !r.why);
  const best = usable.sort((a, b) => b.detailPx - a.detailPx)[0] ?? null;
  return { lenses: ranked.sort((a, b) => a.zoom - b.zoom), best };
}

/**
 * Frame `sel` (view at the profile's zoom) on a running phone session: zoom, autofocus scan on the
 * selection, back off from a lens that cannot focus that close, then a centred crop.
 * `device.caps` gives zoomRange, lenses and focusRange. Returns the profile changes and notes for the person.
 */
export async function frameSelection(session, profile, sel, caps, { onStep = () => {} } = {}) {
  const z0 = profile.zoom ?? 1, rotate = profile.rotate ?? 0;
  // Only the logical camera switches lenses with the zoom; a lens opened on its own stays itself.
  const lenses = caps.lenses && caps.lensId == null ? caps.lenses : null;
  const ownLens = caps.lensId != null ? caps.lenses?.find((l) => l.id === caps.lensId) : null;
  const notes = [];
  const avoid = [];
  let plan, scan;
  for (let attempt = 0; attempt < 3; attempt++) {
    plan = planZoom(sel, z0, { zoomRange: caps.zoomRange, lenses, avoid });
    onStep(`Zooming to ${plan.zoom}×${plan.lens ? ` (${lensName(plan.lens)} lens)` : ''}…`);
    let active = await session.control.zoom(plan.zoom);
    // The camera decides when to switch lenses, and not exactly at the lens's zoom (with hysteresis, and
    // lower than its focal length suggests). Step down until it reports a lens that can focus on the subject.
    while (active && avoid.includes(active) && plan.zoom - 0.1 >= caps.zoomRange[0]) {
      plan.zoom = Math.round((plan.zoom - 0.1) * 100) / 100;
      plan.limitedBy = 'focus';
      onStep(`Zooming to ${plan.zoom}× to leave the ${lensName(lenses.find((l) => l.id === active))} lens…`);
      active = await session.control.zoom(plan.zoom);
    }
    if (active && lenses) plan.lens = lenses.find((l) => l.id === active) ?? plan.lens;
    if (!caps.focusRange) break;
    const region = viewToCamera(rezoom(sel, z0, plan.zoom), rotate);
    onStep('Focusing on the selection…');
    scan = await session.control.scan(region);
    // A lens at its nearest focus is probably short of the subject (the telephoto reports "focused" there):
    // use a lens that focuses closer, at a lower zoom.
    const near = plan.lens?.nearest;
    if (scan && near > 0 && scan.focus >= near - 0.05 && lenses.some((l) => l.zoom < plan.lens.zoom && l.nearest > near)) {
      notes.push(`The ${lensName(plan.lens)} lens cannot focus closer than ${cm(near)} cm and the subject is nearer, `
        + `so the camera zoom stays below the point where the camera switches to it (move the camera back to ${cm(near)} cm or more to use it).`);
      avoid.push(plan.lens.id);
      continue;
    }
    break;
  }
  const crop = centeredCrop(sel, z0, plan.zoom);
  const changes = { zoom: plan.zoom, crop, focusRegion: (() => { const s = rezoom(sel, z0, plan.zoom); return { x: r4(s.x), y: r4(s.y), w: r4(s.w), h: r4(s.h) }; })() };
  if (scan) {
    // within the camera's range: a lens at its nearest focus reports a little past it (2.13 on a 2.0 lens)
    const top = caps.focusRange?.[1] ?? Infinity;
    changes.focus = Math.min(Math.round(scan.focus * 100) / 100, top);
    await session.control.focus(changes.focus);
    if (!scan.ok) notes.push('Autofocus could not lock on the selection: check the picture and adjust the focus by hand.');
  }
  // Which lens would show the subject with the most detail (the selection in the main lens's 1x view).
  const inUse = plan.lens ?? ownLens ?? null;
  const selEq = rezoom(viewToCamera(sel, rotate), z0 * baseZoom(caps), 1);
  const subject = scan ? { focus: scan.focus, atLimit: !!(inUse?.nearest > 0 && scan.focus >= inUse.nearest - 0.05) } : null;
  const ranking = caps.lenses ? rankLenses(selEq, subject, caps.lenses, inUse) : null;
  if (ownLens && subject?.atLimit && ranking?.best && ranking.best.id !== ownLens.id) {
    notes.push(`This lens cannot focus closer than ${cm(ownLens.nearest)} cm and the subject seems nearer: use lens ${ranking.best.n} (${ranking.best.kind}).`);
  }
  if (ranking?.best && inUse && ranking.best.id !== inUse.id) {
    const cur = ranking.lenses.find((r) => r.id === inUse.id);
    const gain = cur?.detailPx ? Math.round((ranking.best.detailPx / cur.detailPx) * 10) / 10 : null;
    if (!gain || gain > 1.1) notes.push(`Lens ${ranking.best.n} (${ranking.best.kind}) would show it with more detail (${ranking.best.detailPx} sensor pixels across${gain ? `, ${gain}× this lens` : ''}).`);
  }
  const digital = crop.w < 1 ? Math.round(10 / crop.w) / 10 : 1;
  if (plan.limitedBy === 'centre' && digital > 1.05) {
    notes.push(`The camera zoom stops at ${plan.zoom}× to keep the selection centred (the zoom is centred on the sensor); `
      + `the remaining ${digital}× is a digital crop. Centre the camera on the subject to use more camera zoom.`);
  } else if (plan.limitedBy === 'range' && digital > 1.05) {
    notes.push(`The camera zoom is at its maximum (${plan.zoom}×); the remaining ${digital}× is a digital crop.`);
  } else if (plan.limitedBy === 'selection') {
    notes.push('The selection is larger than the camera can show centred at its widest; the crop is shifted to fit.');
  }
  return { changes, lens: inUse, digitalCrop: digital, scan: scan ?? null, notes,
    ranking: ranking ? { lenses: ranking.lenses, best: ranking.best?.id ?? null, inUse: inUse?.id ?? null } : null };
}
