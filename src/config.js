import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, parse as parsePath } from 'node:path';
import { UserError } from './util.js';

export const CONFIG_VERSION = 1;
const DIR = '.agent-eye';
const FILE = 'config.json';

export const FULL_CROP = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });

export function globalConfigPath() {
  return join(process.env.AGENT_EYE_HOME || join(homedir(), '.config', 'agent-eye'), FILE);
}

/** Nearest .agent-eye/config.json walking up from cwd, then the global one. */
export function findConfigPath(cwd = process.cwd()) {
  let dir = resolve(cwd);
  const { root } = parsePath(dir);
  for (;;) {
    const p = join(dir, DIR, FILE);
    if (existsSync(p)) return p;
    if (dir === root) break;
    dir = dirname(dir);
  }
  const g = globalConfigPath();
  return existsSync(g) ? g : null;
}

export function configPathForWrite({ cwd = process.cwd(), global = false } = {}) {
  if (global) return globalConfigPath();
  return findConfigPath(cwd) ?? join(resolve(cwd), DIR, FILE);
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Validate and normalise a profile. Throws UserError listing every problem. */
export function normalizeProfile(input) {
  const errors = [];
  const p = input && typeof input === 'object' ? input : {};
  const out = {};

  if (typeof p.source !== 'string' || !/^(mac:.+|android:[^/]+\/\d+)$/.test(p.source)) {
    errors.push('source must be "mac:<camera name>" or "android:<serial>/<camera id>" (see `agent-eye devices`)');
  } else out.source = p.source;

  for (const k of ['width', 'height']) {
    if (!Number.isInteger(p[k]) || p[k] < 16 || p[k] > 8192) errors.push(`${k} must be an integer between 16 and 8192`);
    else out[k] = p[k];
  }
  if (!isNum(p.fps) || p.fps < 1 || p.fps > 480) errors.push('fps must be a number between 1 and 480');
  else out.fps = p.fps;

  const zoom = p.zoom ?? 1;
  if (!isNum(zoom) || zoom < 1 || zoom > 20) errors.push('zoom must be a number between 1 and 20');
  else out.zoom = zoom;

  const crop = p.crop ?? FULL_CROP;
  const { x, y, w, h } = crop;
  if (![x, y, w, h].every(isNum) || x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.0001 || y + h > 1.0001) {
    errors.push('crop must be {x,y,w,h} as fractions of the frame, with x+w<=1 and y+h<=1');
  } else out.crop = { x, y, w, h };

  const rotate = p.rotate ?? 0;
  if (![0, 90, 180, 270].includes(rotate)) errors.push('rotate must be 0, 90, 180 or 270');
  else out.rotate = rotate;

  if (p.bitrate !== undefined) {
    if (!isNum(p.bitrate) || p.bitrate < 1 || p.bitrate > 200) errors.push('bitrate (Mbit/s) must be between 1 and 200');
    else out.bitrate = p.bitrate;
  }
  if (p.note !== undefined) out.note = String(p.note).slice(0, 500);

  if (errors.length) throw new UserError(`Invalid profile:\n  - ${errors.join('\n  - ')}`, { code: 2 });
  if (out.source?.startsWith('mac:') && out.zoom !== 1) {
    throw new UserError('Native zoom is only available on Android cameras. For a Mac camera use "crop".', { code: 2 });
  }
  return out;
}

export function emptyConfig() {
  return { version: CONFIG_VERSION, default: null, profiles: {} };
}

export function loadConfig(path) {
  if (!path || !existsSync(path)) return null;
  let cfg;
  try { cfg = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { throw new UserError(`Cannot read ${path}: ${e.message}`, { code: 2 }); }
  if (cfg.version !== CONFIG_VERSION || typeof cfg.profiles !== 'object') {
    throw new UserError(`${path} has an unsupported format (expected version ${CONFIG_VERSION}).`, { code: 2 });
  }
  return cfg;
}

export function saveConfig(path, cfg) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
  renameSync(tmp, path);
}

/** Add or replace a confirmed profile. The first profile becomes the default. */
export function upsertProfile(cfg, name, profile, { makeDefault = false, now = new Date() } = {}) {
  if (!/^[\w.-]{1,40}$/.test(name) || name === '__proto__') throw new UserError('Profile name must be 1-40 chars of letters, digits, "_", "-" or "." (not "__proto__").', { code: 2 });
  const next = { ...cfg, profiles: { ...cfg.profiles } };
  next.profiles[name] = { ...normalizeProfile(profile), confirmedAt: now.toISOString() };
  if (makeDefault || !next.default || !Object.hasOwn(next.profiles, next.default)) next.default = name;
  return next;
}

export function getProfile(cfg, name) {
  const key = name ?? cfg?.default;
  const p = key && cfg?.profiles && Object.hasOwn(cfg.profiles, key) ? cfg.profiles[key] : null;
  if (!p) {
    const known = Object.keys(cfg?.profiles ?? {});
    throw new UserError(
      key ? `No profile named "${key}".` : 'No default profile is set.',
      { code: 2, hint: known.length ? `Known profiles: ${known.join(', ')}` : 'Run `agent-eye setup`.' });
  }
  return { name: key, ...p };
}
