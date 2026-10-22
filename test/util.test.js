import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBin } from '../src/util.js';

test('findBin finds Windows tools through PATHEXT (ffmpeg.exe)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ae-bin-'));
  writeFileSync(join(dir, 'ffmpeg.exe'), '');
  const env = { Path: `C:\\nowhere;${dir}`, PATHEXT: '.COM;.EXE;.BAT' };
  assert.equal(findBin('ffmpeg', { platform: 'win32', env }), join(dir, 'ffmpeg.exe'));
  assert.equal(findBin('ffprobe', { platform: 'win32', env }), null);
});

test('findBin on Unix needs the executable bit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ae-bin-'));
  writeFileSync(join(dir, 'tool-x'), '');
  writeFileSync(join(dir, 'tool-y'), '');
  chmodSync(join(dir, 'tool-y'), 0o755);
  const env = { PATH: dir };
  assert.equal(findBin('tool-x', { platform: 'darwin', env }), null);
  assert.equal(findBin('tool-y', { platform: 'darwin', env }), join(dir, 'tool-y'));
});
