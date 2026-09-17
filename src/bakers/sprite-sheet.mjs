// sprite-sheet: pack an animated GIF into one RGBA atlas plus per-frame
// rectangles, so a consumer only decodes a single PNG.
//
// The GIF decoder composites every frame onto the logical screen, so all
// frames share one size and a simple shelf (row) packer is exact:
//
//   - frames are placed left-to-right, wrapping to a new row when the next
//     frame would cross `maxWidth` (default 2048);
//   - the sheet is trimmed to the used area unless `powerOfTwo` pads both
//     dimensions up to the next power of two;
//   - consecutive identical frames are not given a new rectangle. With
//     `dedupe` (default true) the duplicate frame reuses the previous
//     rectangle and keeps its own `delay`, so playback timing is unchanged.
//     Set `dedupe: false` to allocate a rectangle per decoded frame.
//
// Record shape:
//
//   {
//     sheet: { width, height, format: 'rgba8', data },  // base64 RGBA rows
//     frames: [{ index, x, y, w, h, delay, delayCs, duplicate }],
//     loops,                                            // GIF loop count (null/0)
//     fps,                                              // present when delays agree
//     source: { width, height, frameCount, version },
//   }

import { decodeGif } from '../decoders/gif.mjs';
import { toBase64 } from '../image.mjs';
import { imageValue, positiveInt, requireFile } from './util.mjs';

export const type = 'sprite-sheet';
export const defaultBucket = 'sprites';

function nextPowerOfTwo(value) {
  let size = 1;
  while (size < value) size *= 2;
  return size;
}

function framesEqual(a, b) {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

export function bake(job, ctx) {
  const options = ctx.bake ?? {};
  const slot = options.slot ?? 'result';
  const gif = decodeGif(requireFile(ctx, slot, type));
  const maxWidth = positiveInt(options.maxWidth ?? 2048, `${type}.maxWidth`);
  const dedupe = options.dedupe !== false;

  const frameWidth = gif.width;
  const frameHeight = gif.height;
  if (frameWidth > maxWidth) {
    throw new Error(`${type}: frame width ${frameWidth} exceeds maxWidth ${maxWidth}`);
  }

  // Shelf packing. `rects` only grows for unique frames.
  const rects = [];
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  let maxRight = 0;
  let maxBottom = 0;
  const frames = [];
  let previous = null;

  for (const frame of gif.frames) {
    let rect;
    let duplicate = false;
    if (dedupe && previous && framesEqual(previous.data, frame.data)) {
      rect = previous.rect;
      duplicate = true;
    } else {
      if (cursorX + frameWidth > maxWidth) {
        cursorX = 0;
        cursorY += rowHeight;
        rowHeight = 0;
      }
      rect = { x: cursorX, y: cursorY, w: frameWidth, h: frameHeight };
      cursorX += frameWidth;
      rowHeight = Math.max(rowHeight, frameHeight);
      maxRight = Math.max(maxRight, rect.x + rect.w);
      maxBottom = Math.max(maxBottom, rect.y + rect.h);
      rects.push({ rect, data: frame.data });
      previous = { rect, data: frame.data };
    }
    frames.push({
      index: frame.index,
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
      delay: frame.delay,
      delayCs: frame.delayCs,
      duplicate,
    });
  }

  const baseWidth = Math.max(1, maxRight);
  const baseHeight = Math.max(1, maxBottom);
  const width = options.powerOfTwo ? nextPowerOfTwo(baseWidth) : baseWidth;
  const height = options.powerOfTwo ? nextPowerOfTwo(baseHeight) : baseHeight;

  const sheet = new Uint8Array(width * height * 4);
  for (const { rect, data } of rects) {
    for (let y = 0; y < rect.h; y++) {
      const source = y * frameWidth * 4;
      const target = ((rect.y + y) * width + rect.x) * 4;
      sheet.set(data.subarray(source, source + frameWidth * 4), target);
    }
  }

  const delays = new Set(gif.frames.map((frame) => frame.delayCs));
  const fps = delays.size === 1 && gif.frames[0].delayCs > 0
    ? Math.round((100 / gif.frames[0].delayCs) * 1e6) / 1e6
    : (typeof options.fps === 'number' ? options.fps : undefined);

  return {
    bucket: options.bucket ?? defaultBucket,
    key: options.name ?? job.id,
    value: {
      sheet: imageValue(sheet, width, height),
      frames,
      loops: gif.loops,
      ...(fps === undefined ? {} : { fps }),
      source: { width: gif.width, height: gif.height, frameCount: gif.frames.length, version: gif.version },
    },
  };
}

export default bake;
