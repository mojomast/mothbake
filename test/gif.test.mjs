import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeGif } from '../src/decoders/gif.mjs';
import { readFixture } from './helpers.mjs';
import { buildGif } from './gif-builder.mjs';

const BW = [
  [0, 0, 0],
  [255, 255, 255],
];
const RGB = [
  [0, 0, 0],
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
];

const pixel = (frame, x, y) => Array.from(frame.data.subarray((y * frame.w + x) * 4, (y * frame.w + x) * 4 + 4));

test('decodeGif reads a generated multi-frame animation', () => {
  const gif = decodeGif(readFixture('anim.gif'));
  assert.equal(gif.version, '89a');
  assert.equal(gif.width, 8);
  assert.equal(gif.height, 8);
  assert.equal(gif.frames.length, 3);
  assert.equal(gif.loops, 0, 'ffmpeg marks the animation as looping forever');
  for (const frame of gif.frames) {
    assert.equal(frame.data.length, gif.width * gif.height * 4);
    assert.equal(frame.delay, 0.1);
    assert.equal(frame.delayCs, 10);
  }
  assert.notDeepEqual(Buffer.from(gif.frames[0].data), Buffer.from(gif.frames[2].data), 'frames should differ');
});

test('decodeGif reads delays, loop count and transparency', () => {
  const gif = decodeGif(
    buildGif({
      width: 2,
      height: 2,
      palette: RGB,
      loops: 3,
      frames: [
        { pixels: [0, 0, 0, 0], delay: 5, disposal: 1 },
        { pixels: [1, 2, 1, 2], delay: 20, disposal: 2, transparent: 2 },
        { pixels: [3], x: 0, y: 0, w: 1, h: 1, disposal: 1 },
      ],
    }),
  );
  assert.equal(gif.loops, 3);
  assert.deepEqual(gif.frames.map((frame) => frame.delay), [0.05, 0.2, 0]);
  assert.deepEqual(gif.frames.map((frame) => frame.delayCs), [5, 20, 0]);
  assert.equal(gif.frames[1].transparent, 2);
  // Transparent pixels keep the previous frame's colour.
  assert.deepEqual(pixel(gif.frames[1], 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(pixel(gif.frames[1], 1, 0), [0, 0, 0, 255]);
  // Disposal 2 cleared the previous full-screen frame before this 1x1 draw.
  assert.deepEqual(pixel(gif.frames[2], 0, 0), [0, 0, 255, 255]);
  assert.deepEqual(pixel(gif.frames[2], 1, 1), [0, 0, 0, 0]);
});

test('decodeGif restores the canvas for disposal method 3', () => {
  const gif = decodeGif(
    buildGif({
      width: 2,
      height: 2,
      palette: BW,
      frames: [
        { pixels: [0, 0, 0, 0], disposal: 1 },
        { pixels: [1, 1, 1, 1], disposal: 3 },
        { pixels: [0, 0, 0, 0], transparent: 0, disposal: 1 },
      ],
    }),
  );
  assert.deepEqual(pixel(gif.frames[2], 0, 0), [0, 0, 0, 255]);
  assert.deepEqual(pixel(gif.frames[2], 1, 1), [0, 0, 0, 255]);
});

test('decodeGif de-interlaces stored rows', () => {
  const pixels = [0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0];
  const plain = decodeGif(buildGif({ width: 4, height: 4, palette: BW, frames: [{ pixels }] }));
  const interlaced = decodeGif(buildGif({ width: 4, height: 4, palette: BW, frames: [{ pixels, interlace: true }] }));
  assert.deepEqual(Buffer.from(interlaced.frames[0].data), Buffer.from(plain.frames[0].data));
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      assert.equal(pixel(interlaced.frames[0], x, y)[1], pixels[y * 4 + x] * 255);
    }
  }
});

test('decodeGif reports malformed input clearly', () => {
  assert.throws(() => decodeGif(Buffer.alloc(4)), /file too small/);
  assert.throws(() => decodeGif(Buffer.from('notagif!!!!!!')), /not a GIF/);
  const truncated = buildGif({ width: 2, height: 2, palette: BW, frames: [{ pixels: [0, 0, 0, 0] }] }).subarray(0, 20);
  assert.throws(() => decodeGif(truncated), /truncated|no image frames|missing trailer/);
  const noTrailer = buildGif({ width: 2, height: 2, palette: BW, frames: [{ pixels: [0, 0, 0, 0] }] }).subarray(0, -1);
  assert.throws(() => decodeGif(noTrailer), /missing trailer/);
  const badIntroducer = Buffer.from(buildGif({ width: 2, height: 2, palette: BW, frames: [{ pixels: [0, 0, 0, 0] }] }));
  badIntroducer[13 + 6] = 0x99; // first byte after the global colour table
  assert.throws(() => decodeGif(badIntroducer), /unknown block introducer/);
});
