// Dependency-free GIF87a/89a decoder.
//
// Covers the whole format a sprite/UI asset can arrive in: global and local
// colour tables, LZW image data, interlacing, transparency and per-frame
// disposal, plus the NETSCAPE loop count. Frames are composited onto a
// transparent logical-screen canvas, so every frame in the result is the same
// `width` x `height` and can be packed directly into a sheet.
//
// Returned shape:
//
//   {
//     width, height,             // logical screen size
//     version: '87a' | '89a',
//     background,                // background colour index (from the LSD)
//     loops,                     // NETSCAPE loop count; null when absent,
//                                // 0 means loop forever
//     frames: [{
//       index,                   // 0-based frame number
//       delay,                   // seconds (GIF centiseconds / 100)
//       delayCs,                 // raw centisecond delay
//       disposal,                // 0-7 disposal method
//       transparent,             // transparent colour index or null
//       x, y, w, h,              // frame rect on the logical screen
//       data,                    // Uint8Array RGBA, width*height*4, composited
//     }],
//   }
//
// Deliberate limits and choices:
//   - The canvas starts fully transparent (0,0,0,0); disposal method 2 clears
//     to transparent rather than to the background colour so sheets composite
//     predictably over any backdrop.
//   - Disposal methods 4-7 are reserved by the spec and treated as 0.
//   - Local colour tables that are too short for an index resolve to opaque
//     black instead of throwing, matching how tolerant viewers behave.
//   - Extra pixels past the frame rect are ignored; a truncated LZW stream is
//     a hard error.

const SIGNATURES = { '87a': 'GIF87a', '89a': 'GIF89a' };

const DISPOSAL_NONE = 0;
const DISPOSAL_KEEP = 1;
const DISPOSAL_BACKGROUND = 2;
const DISPOSAL_PREVIOUS = 3;

function signatureOf(buffer) {
  for (const [version, signature] of Object.entries(SIGNATURES)) {
    let match = true;
    for (let i = 0; i < 6; i++) {
      if (buffer[i] !== signature.charCodeAt(i)) {
        match = false;
        break;
      }
    }
    if (match) return version;
  }
  return null;
}

/** Read a chain of sub-blocks (each `size` byte then `size` bytes) into one buffer. */
function readSubBlocks(buffer, start, label) {
  const parts = [];
  let offset = start;
  for (;;) {
    if (offset >= buffer.length) throw new Error(`gif: truncated ${label} sub-blocks`);
    const size = buffer[offset];
    offset += 1;
    if (size === 0) break;
    if (offset + size > buffer.length) throw new Error(`gif: truncated ${label} sub-block (needed ${size} bytes at ${offset})`);
    parts.push(buffer.subarray(offset, offset + size));
    offset += size;
  }
  return { data: Buffer.concat(parts), offset };
}

function readColorTable(buffer, offset, entries, label) {
  const bytes = entries * 3;
  if (offset + bytes > buffer.length) throw new Error(`gif: truncated ${label} (needed ${bytes} bytes at ${offset})`);
  return buffer.subarray(offset, offset + bytes);
}

/**
 * Decode a GIF LZW stream to palette indices.
 *
 * @param {Buffer} data Concatenated image-data sub-blocks (without the minimum code size).
 * @param {number} minCodeSize LZW minimum code size (2-8).
 * @param {number} expected Maximum number of pixels to produce.
 */
function lzwDecode(data, minCodeSize, expected) {
  if (minCodeSize < 2 || minCodeSize > 8) {
    throw new Error(`gif: invalid LZW minimum code size ${minCodeSize} (expected 2-8)`);
  }
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let next = endCode + 1;
  let prefix = new Int32Array(4096);
  let suffix = new Uint8Array(4096);
  const reset = () => {
    for (let i = 0; i < clearCode; i++) {
      prefix[i] = -1;
      suffix[i] = i;
    }
    for (let i = clearCode; i < 4096; i++) prefix[i] = -1;
    codeSize = minCodeSize + 1;
    next = endCode + 1;
  };
  reset();

  const out = new Uint8Array(expected);
  let produced = 0;
  let bitBuffer = 0;
  let bitCount = 0;
  let byteOffset = 0;
  let previous = -1;

  const stack = new Uint8Array(4096);

  const emit = (code) => {
    let depth = 0;
    let current = code;
    while (current >= 0) {
      if (depth >= stack.length) throw new Error('gif: corrupt LZW dictionary chain');
      stack[depth++] = suffix[current];
      current = prefix[current];
    }
    while (depth > 0) {
      if (produced >= out.length) return;
      out[produced++] = stack[--depth];
    }
  };

  for (;;) {
    while (bitCount < codeSize) {
      if (byteOffset >= data.length) {
        // No explicit end code: accept what was produced.
        byteOffset = data.length;
        break;
      }
      bitBuffer |= data[byteOffset++] << bitCount;
      bitCount += 8;
    }
    if (bitCount < codeSize) break;
    const code = bitBuffer & ((1 << codeSize) - 1);
    bitBuffer >>= codeSize;
    bitCount -= codeSize;

    if (code === clearCode) {
      reset();
      previous = -1;
      continue;
    }
    if (code === endCode) break;
    if (code > next) throw new Error(`gif: LZW code ${code} out of range (dictionary holds ${next})`);

    if (previous === -1) {
      if (code >= clearCode) throw new Error(`gif: LZW stream starts with code ${code}`);
      emit(code);
    } else if (code < next) {
      emit(code);
      if (next < 4096) {
        prefix[next] = previous;
        // First symbol of the entry: copy from the previous entry. `emit`
        // walks prefix chains, so resolve the first byte directly.
        let current = code;
        while (prefix[current] >= 0) current = prefix[current];
        suffix[next] = suffix[current];
        next++;
      }
    } else {
      // KwKwK case: a reference to the entry being built.
      if (next >= 4096) throw new Error('gif: LZW dictionary overflow');
      let current = previous;
      while (prefix[current] >= 0) current = prefix[current];
      suffix[next] = suffix[current];
      prefix[next] = previous;
      next++;
      emit(next - 1);
    }
    if (next === (1 << codeSize) && codeSize < 12) codeSize++;
    previous = code;
    if (produced >= out.length && byteOffset >= data.length) break;
  }

  if (produced < out.length) {
    throw new Error(`gif: LZW stream ended after ${produced} of ${out.length} pixels`);
  }
  return out;
}

/** Expand interlaced GIF rows (4 passes: 0/8, 4/12, 2/6, 1/3). */
function deinterlace(indices, width, height) {
  const out = new Uint8Array(indices.length);
  const passes = [
    [0, 8],
    [4, 8],
    [2, 4],
    [1, 2],
  ];
  let source = 0;
  for (const [start, step] of passes) {
    for (let y = start; y < height; y += step) {
      const row = y * width;
      for (let x = 0; x < width; x++) out[row + x] = indices[source++];
    }
  }
  return out;
}

/**
 * Decode a GIF image into composited RGBA frames.
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {{
 *   width: number, height: number, version: string, background: number,
 *   loops: number|null,
 *   frames: Array<{ index: number, delay: number, delayCs: number, disposal: number,
 *     transparent: number|null, x: number, y: number, w: number, h: number, data: Uint8Array }>,
 * }}
 */
export function decodeGif(buffer) {
  if (!buffer || buffer.length < 13) throw new Error('gif: file too small');
  const version = signatureOf(buffer);
  if (!version) throw new Error('gif: not a GIF (bad signature, expected GIF87a or GIF89a)');

  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  if (!width || !height) throw new Error(`gif: invalid logical screen size ${width}x${height}`);
  if (width * height > 100_000_000) throw new Error(`gif: logical screen ${width}x${height} is too large to decode`);
  const packed = buffer[10];
  const background = buffer[11];
  const globalTableFlag = (packed & 0x80) !== 0;
  const globalTableEntries = 1 << ((packed & 0x07) + 1);
  let offset = 13;
  let globalTable = null;
  if (globalTableFlag) {
    globalTable = readColorTable(buffer, offset, globalTableEntries, 'global colour table');
    offset += globalTableEntries * 3;
  }

  const canvas = new Uint8Array(width * height * 4); // transparent
  const frames = [];
  let loops = null;
  let pending = null; // graphic control extension
  let previousRect = null;
  let previousDisposal = DISPOSAL_NONE;
  let saved = null;
  let sawTrailer = false;

  const colorFor = (table, index) => {
    const base = index * 3;
    if (!table || base + 2 >= table.length) return [0, 0, 0];
    return [table[base], table[base + 1], table[base + 2]];
  };

  const clearRect = (rect) => {
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      if (y < 0 || y >= height) continue;
      const row = y * width;
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        if (x < 0 || x >= width) continue;
        const target = (row + x) * 4;
        canvas[target] = 0;
        canvas[target + 1] = 0;
        canvas[target + 2] = 0;
        canvas[target + 3] = 0;
      }
    }
  };

  while (offset < buffer.length) {
    const introducer = buffer[offset++];
    if (introducer === 0x3b) {
      sawTrailer = true;
      break;
    }
    if (introducer === 0x21) {
      if (offset >= buffer.length) throw new Error('gif: truncated extension block');
      const label = buffer[offset++];
      if (label === 0xf9) {
        const block = readSubBlocks(buffer, offset, 'graphic control extension');
        offset = block.offset;
        if (block.data.length < 4) throw new Error('gif: graphic control extension too short');
        const flags = block.data[0];
        pending = {
          disposal: (flags >> 2) & 0x07,
          transparent: (flags & 0x01) ? block.data[3] : null,
          delayCs: block.data.readUInt16LE(1),
        };
      } else if (label === 0xff) {
        // Application extension; NETSCAPE2.0 carries the loop count.
        if (offset >= buffer.length) throw new Error('gif: truncated application extension');
        const size = buffer[offset];
        const name = buffer.toString('ascii', offset + 1, offset + 1 + size);
        offset += 1 + size;
        const block = readSubBlocks(buffer, offset, 'application extension');
        offset = block.offset;
        if (name.startsWith('NETSCAPE') && block.data.length >= 3 && block.data[0] === 1) {
          loops = block.data.readUInt16LE(1);
        }
      } else {
        const block = readSubBlocks(buffer, offset, 'extension');
        offset = block.offset;
      }
      continue;
    }
    if (introducer !== 0x2c) {
      throw new Error(`gif: unknown block introducer 0x${introducer.toString(16).padStart(2, '0')}`);
    }

    if (offset + 9 > buffer.length) throw new Error('gif: truncated image descriptor');
    const x = buffer.readUInt16LE(offset);
    const y = buffer.readUInt16LE(offset + 2);
    const w = buffer.readUInt16LE(offset + 4);
    const h = buffer.readUInt16LE(offset + 6);
    const imagePacked = buffer[offset + 8];
    offset += 9;
    if (w <= 0 || h <= 0) throw new Error(`gif: invalid frame size ${w}x${h}`);
    const localTableFlag = (imagePacked & 0x80) !== 0;
    const interlaced = (imagePacked & 0x40) !== 0;
    const localTableEntries = 1 << ((imagePacked & 0x07) + 1);
    let localTable = null;
    if (localTableFlag) {
      localTable = readColorTable(buffer, offset, localTableEntries, 'local colour table');
      offset += localTableEntries * 3;
    }
    if (offset >= buffer.length) throw new Error('gif: truncated image data (missing LZW minimum code size)');
    const minCodeSize = buffer[offset++];
    const block = readSubBlocks(buffer, offset, 'image data');
    offset = block.offset;

    // Apply the previous frame's disposal before drawing this one.
    if (previousDisposal === DISPOSAL_BACKGROUND && previousRect) {
      clearRect(previousRect);
    } else if (previousDisposal === DISPOSAL_PREVIOUS && saved) {
      canvas.set(saved);
    }
    const disposal = pending?.disposal ?? DISPOSAL_NONE;
    if (disposal === DISPOSAL_PREVIOUS) saved = canvas.slice();

    const table = localTable ?? globalTable;
    let indices = lzwDecode(block.data, minCodeSize, w * h);
    if (interlaced) indices = deinterlace(indices, w, h);
    const transparent = pending?.transparent ?? null;
    const rectX = Math.max(0, x);
    const rectY = Math.max(0, y);
    const rectW = Math.min(w, width - rectX);
    const rectH = Math.min(h, height - rectY);
    for (let fy = 0; fy < rectH; fy++) {
      const row = (rectY + fy) * width;
      for (let fx = 0; fx < rectW; fx++) {
        const paletteIndex = indices[fy * w + fx];
        if (paletteIndex === transparent) continue;
        const [r, g, b] = colorFor(table, paletteIndex);
        const target = (row + rectX + fx) * 4;
        canvas[target] = r;
        canvas[target + 1] = g;
        canvas[target + 2] = b;
        canvas[target + 3] = 255;
      }
    }

    frames.push({
      index: frames.length,
      delay: (pending?.delayCs ?? 0) / 100,
      delayCs: pending?.delayCs ?? 0,
      disposal,
      transparent,
      x,
      y,
      w,
      h,
      data: canvas.slice(),
    });
    previousRect = { x, y, w, h };
    previousDisposal = disposal;
    pending = null;
  }

  if (!frames.length) throw new Error('gif: no image frames found');
  if (!sawTrailer) throw new Error('gif: missing trailer (0x3b); file may be truncated');
  return { width, height, version, background, loops, frames };
}

export default decodeGif;
