import test from 'node:test';
import assert from 'node:assert/strict';
import { JpegSplitter } from '../src/mjpeg.js';

const jpeg = (n) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(n, 7), Buffer.from([0xff, 0xd9])]);

test('splits frames across arbitrary chunk boundaries', () => {
  const frames = [];
  const s = new JpegSplitter((f) => frames.push(Buffer.from(f)));
  const all = Buffer.concat([jpeg(10), jpeg(20), jpeg(5)]);
  for (let i = 0; i < all.length; i += 7) s.push(all.subarray(i, i + 7));
  assert.deepEqual(frames.map((f) => f.length), [14, 24, 9]);
});

test('drops garbage before the first start marker', () => {
  const frames = [];
  const s = new JpegSplitter((f) => frames.push(f.length));
  s.push(Buffer.concat([Buffer.from([1, 2, 3]), jpeg(4)]));
  assert.deepEqual(frames, [8]);
});
