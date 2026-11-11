import test from 'node:test';
import assert from 'node:assert/strict';
import { centeredCrop, frameSelection, lensAt, maxCenteredZoom, pictureToView, planZoom, rezoom, viewToCamera } from '../src/framing.js';

const near = (a, b, eps = 1e-9) => Object.keys(b).every((k) => Math.abs(a[k] - b[k]) < eps);
const LENSES = [{ id: '0', zoom: 1, nearest: 10 }, { id: '2', zoom: 0.61, nearest: 40 }, { id: '3', zoom: 2.16, nearest: 2 }];

test('view rectangles map back through the rotation agent-eye applies on the Mac', () => {
  const r = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
  assert.deepEqual(viewToCamera(r, 0), r);
  // transpose=1 turns the camera image clockwise: its top-left corner ends up top-right.
  assert.ok(near(viewToCamera({ x: 0.9, y: 0, w: 0.1, h: 0.1 }, 90), { x: 0, y: 0, w: 0.1, h: 0.1 }));
  assert.ok(near(viewToCamera({ x: 0, y: 0.9, w: 0.1, h: 0.1 }, 270), { x: 0, y: 0, w: 0.1, h: 0.1 }));
  assert.ok(near(viewToCamera(r, 180), { x: 0.6, y: 0.4, w: 0.3, h: 0.4 }));
});

test('zoom is centred: rectangles scale around the middle; picture coordinates go through the crop', () => {
  assert.ok(near(rezoom({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 1, 2), { x: 0, y: 0, w: 1, h: 1 }));
  assert.ok(near(pictureToView({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, { x: 0.2, y: 0.2, w: 0.4, h: 0.4 }), { x: 0.4, y: 0.4, w: 0.2, h: 0.2 }));
});

test('the most camera zoom keeps an off-centre selection centred in a crop with the frame proportions', () => {
  const centred = { x: 0.45, y: 0.45, w: 0.1, h: 0.1 };
  assert.ok(maxCenteredZoom(centred, 1) > 8);
  const corner = { x: 0.26, y: 0.57, w: 0.27, h: 0.32 };
  const z = maxCenteredZoom(corner, 1);
  assert.ok(z > 1.1 && z < 1.3, String(z));
  const crop = centeredCrop(corner, 1, z);
  assert.equal(crop.w, crop.h);
  assert.ok(crop.x >= 0 && crop.y >= 0 && crop.x + crop.w <= 1.0001 && crop.y + crop.h <= 1.0001);
  const s = rezoom(corner, 1, z); // the selection is in the middle of the crop
  assert.ok(Math.abs(crop.x + crop.w / 2 - (s.x + s.w / 2)) < 0.001);
});

test('lens at a zoom, and a plan that stays below a lens that cannot focus on the subject', () => {
  assert.equal(lensAt(LENSES, 0.5).id, '2');
  assert.equal(lensAt(LENSES, 1.5).id, '0');
  assert.equal(lensAt(LENSES, 3).id, '3');
  const sel = { x: 0.45, y: 0.45, w: 0.1, h: 0.1 };
  assert.equal(planZoom(sel, 1, { zoomRange: [0.5, 10], lenses: LENSES }).lens.id, '3');
  const p = planZoom(sel, 1, { zoomRange: [0.5, 10], lenses: LENSES, avoid: ['3'] });
  assert.equal(p.zoom, 2.11); assert.equal(p.lens.id, '0'); assert.equal(p.limitedBy, 'focus');
  assert.equal(planZoom(sel, 1, { zoomRange: [1, 4] }).limitedBy, 'range');
});

/** A camera like the Motorola: telephoto from 2.2x going up, kept down to 2.0x coming back (hysteresis). */
function fakeCamera({ subject = 4.25 } = {}) {
  let zoom = 1, lens = '0';
  const log = [];
  return {
    log,
    control: {
      async zoom(z) { log.push(`zoom ${z}`); lens = z >= 2.2 || (lens === '3' && z > 2.0) ? '3' : z < 1 ? '2' : '0'; zoom = z; return lens; },
      async scan(region) { log.push(`scan ${region ? 'region' : 'all'}`); return { focus: Math.min(subject, lens === '3' ? 2.2 : 10), ok: true }; },
      async focus(d) { log.push(`focus ${d}`); },
    },
    get zoom() { return zoom; },
  };
}

test('framing a small centred subject: the telephoto cannot focus that close, so the main lens is used', async () => {
  const cam = fakeCamera();
  const r = await frameSelection(cam, { zoom: 1, rotate: 0 }, { x: 0.45, y: 0.44, w: 0.1, h: 0.12 }, { zoomRange: [0.5, 10], lenses: LENSES, focusRange: [0, 10] });
  assert.equal(r.lens.id, '0');
  assert.ok(r.changes.zoom <= 2.0, `zoom ${r.changes.zoom} must be below where the camera leaves the telephoto`);
  assert.equal(r.changes.focus, 4.25);
  assert.match(r.notes.join(' '), /telephoto lens cannot focus closer than 50 cm/);
  assert.equal(cam.log.at(-1), 'focus 4.25');
});

test('framing a far subject keeps the telephoto; a main-lens-only camera just zooms and focuses', async () => {
  const far = await frameSelection(fakeCamera({ subject: 1 }), { zoom: 1 }, { x: 0.45, y: 0.44, w: 0.1, h: 0.12 }, { zoomRange: [0.5, 10], lenses: LENSES, focusRange: [0, 10] });
  assert.equal(far.lens.id, '3'); assert.ok(far.changes.zoom > 2.16);
  const main = await frameSelection(fakeCamera(), { zoom: 1 }, { x: 0.26, y: 0.57, w: 0.27, h: 0.32 }, { zoomRange: [1, 10], lenses: null, focusRange: [0, 10] });
  assert.ok(main.changes.zoom > 1.1 && main.changes.zoom < 1.3);
  assert.ok(main.digitalCrop > 2);
  assert.match(main.notes[0], /to keep the selection centred/);
});
