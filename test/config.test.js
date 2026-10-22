import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyConfig, findConfigPath, getProfile, normalizeProfile, upsertProfile } from '../src/config.js';

const good = { source: 'android:ABC/0', width: 1920, height: 1080, fps: 60 };

test('normalizeProfile fills defaults', () => {
  const p = normalizeProfile(good);
  assert.deepEqual(p.crop, { x: 0, y: 0, w: 1, h: 1 });
  assert.equal(p.zoom, 1);
  assert.equal(p.rotate, 0);
});

test('normalizeProfile lists every problem at once', () => {
  assert.throws(() => normalizeProfile({ source: 'webcam', width: 5, fps: 0 }), (e) => {
    assert.equal(e.exitCode, 2);
    assert.match(e.message, /source/); assert.match(e.message, /width/); assert.match(e.message, /height/); assert.match(e.message, /fps/);
    return true;
  });
});

test('crop must stay inside the frame', () => {
  assert.throws(() => normalizeProfile({ ...good, crop: { x: 0.6, y: 0, w: 0.6, h: 1 } }), /crop/);
  assert.doesNotThrow(() => normalizeProfile({ ...good, crop: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } }));
});

test('native zoom is rejected for Mac cameras', () => {
  assert.throws(() => normalizeProfile({ source: 'mac:FaceTime HD Camera', width: 1280, height: 720, fps: 30, zoom: 2 }), /crop/);
});

test('first profile becomes default, later ones only on request', () => {
  let cfg = upsertProfile(emptyConfig(), 'a', good);
  cfg = upsertProfile(cfg, 'b', good);
  assert.equal(cfg.default, 'a');
  cfg = upsertProfile(cfg, 'b', good, { makeDefault: true });
  assert.equal(cfg.default, 'b');
  assert.ok(cfg.profiles.b.confirmedAt);
});

test('profile names are restricted', () => {
  assert.throws(() => upsertProfile(emptyConfig(), '../evil', good), /Profile name/);
  assert.throws(() => upsertProfile(emptyConfig(), '__proto__', good), /Profile name/);
});

test('inherited object keys are not profiles', () => {
  const cfg = upsertProfile(emptyConfig(), 'constructor', good);
  assert.deepEqual(JSON.parse(JSON.stringify(cfg)).profiles.constructor.source, good.source);
  assert.equal(getProfile(cfg).name, 'constructor');
  assert.throws(() => getProfile(emptyConfig(), 'toString'), /No profile named "toString"/);
  assert.throws(() => getProfile(upsertProfile(emptyConfig(), 'a', good), 'hasOwnProperty'), /No profile named/);
});

test('getProfile explains what exists', () => {
  const cfg = upsertProfile(emptyConfig(), 'a', good);
  assert.equal(getProfile(cfg).name, 'a');
  assert.throws(() => getProfile(cfg, 'zzz'), (e) => /Known profiles: a/.test(e.hint));
});

test('findConfigPath walks up from a subdirectory', () => {
  const root = mkdtempSync(join(tmpdir(), 'ae-'));
  mkdirSync(join(root, '.agent-eye')); writeFileSync(join(root, '.agent-eye', 'config.json'), '{}');
  mkdirSync(join(root, 'a', 'b'), { recursive: true });
  process.env.AGENT_EYE_HOME = join(root, 'nohome');
  assert.equal(findConfigPath(join(root, 'a', 'b')), join(root, '.agent-eye', 'config.json'));
  assert.equal(findConfigPath(tmpdir()), null);
});
