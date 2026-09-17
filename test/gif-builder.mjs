// Minimal GIF writer for tests: builds GIF87a/89a streams with a global
// colour table, optional transparency/disposal/interlacing, per-frame delays
// and a NETSCAPE loop extension. LZW data is emitted as a literal code per
// pixel (with a clear code before each) so no compressor is needed; it is a
// valid stream that the decoder handles exactly.
//
// Not part of the published package — test scaffolding only.

function ceilLog2(value) {
  let bits = 1;
  while (1 << bits < value) bits++;
  return bits;
}

/** Row-major indices -> the order a GIF interlaced image stores them in. */
export function toInterlaced(rowMajor, width, height) {
  const out = new Uint8Array(rowMajor.length);
  const passes = [
    [0, 8],
    [4, 8],
    [2, 4],
    [1, 2],
  ];
  let source = 0;
  for (const [start, step] of passes) {
    for (let y = start; y < height; y += step) {
      for (let x = 0; x < width; x++) out[source++] = rowMajor[y * width + x];
    }
  }
  return out;
}

function literalLzw(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const codeSize = minCodeSize + 1;
  const codes = [];
  for (const index of indices) codes.push(clearCode, index);
  codes.push(endCode);
  const bytes = [];
  let bitBuffer = 0;
  let bitCount = 0;
  for (const code of codes) {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      bytes.push(bitBuffer & 0xff);
      bitBuffer >>= 8;
      bitCount -= 8;
    }
  }
  if (bitCount > 0) bytes.push(bitBuffer & 0xff);
  return Buffer.from(bytes);
}

function subBlocks(data) {
  const parts = [];
  for (let offset = 0; offset < data.length; offset += 255) {
    const slice = data.subarray(offset, offset + 255);
    parts.push(Buffer.from([slice.length]), slice);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

const u16 = (value) => {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
};

/**
 * @param {{
 *   width: number, height: number,
 *   palette: Array<[number, number, number]>,
 *   frames: Array<{ pixels: number[], delay?: number, disposal?: number,
 *     transparent?: number|null, interlace?: boolean, x?: number, y?: number }>,
 *   loops?: number|null, background?: number, version?: '87a'|'89a',
 * }} spec
 * @returns {Buffer}
 */
export function buildGif(spec) {
  const { width, height, palette, frames, loops = null, background = 0, version = '89a' } = spec;
  const tableBits = ceilLog2(palette.length);
  const tableEntries = 1 << tableBits;
  if (tableEntries > 256) throw new Error('test gif: palette too large');
  const parts = [];
  parts.push(Buffer.from(`GIF${version}`, 'ascii'));
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(width, 0);
  lsd.writeUInt16LE(height, 2);
  lsd[4] = 0x80 | 0x70 | (tableBits - 1); // GCT flag, 8-bit colour resolution
  lsd[5] = background;
  lsd[6] = 0;
  parts.push(lsd);
  const table = Buffer.alloc(tableEntries * 3);
  palette.forEach(([r, g, b], index) => {
    table[index * 3] = r;
    table[index * 3 + 1] = g;
    table[index * 3 + 2] = b;
  });
  parts.push(table);

  if (loops !== null && loops !== undefined) {
    parts.push(Buffer.from([0x21, 0xff, 0x0b]));
    parts.push(Buffer.from('NETSCAPE2.0', 'ascii'));
    parts.push(Buffer.from([0x03, 0x01]), u16(loops), Buffer.from([0x00]));
  }

  for (const frame of frames) {
    const { pixels, delay = 0, disposal = 0, transparent = null, interlace = false, x = 0, y = 0, w = width, h = height } = frame;
    if (pixels.length !== w * h) throw new Error(`test gif: frame has ${pixels.length} pixels for ${w}x${h}`);
    const maxIndex = pixels.length ? Math.max(...pixels) : 0;
    const frameMin = Math.max(2, ceilLog2(maxIndex + 1));
    parts.push(Buffer.from([0x21, 0xf9, 0x04]));
    parts.push(Buffer.from([(disposal << 2) | (transparent === null ? 0 : 0x01)]), u16(delay), Buffer.from([transparent ?? 0, 0x00]));
    parts.push(Buffer.from([0x2c]));
    const descriptor = Buffer.alloc(9);
    descriptor.writeUInt16LE(x, 0);
    descriptor.writeUInt16LE(y, 2);
    descriptor.writeUInt16LE(w, 4);
    descriptor.writeUInt16LE(h, 6);
    descriptor[8] = interlace ? 0x40 : 0x00;
    parts.push(descriptor);
    const ordered = interlace ? toInterlaced(Uint8Array.from(pixels), w, h) : Uint8Array.from(pixels);
    parts.push(Buffer.from([frameMin]));
    parts.push(subBlocks(literalLzw(ordered, frameMin)));
  }

  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}
