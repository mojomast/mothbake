// Dependency-free PNG codec: decode 8-bit truecolour/greyscale/palette images
// and encode truecolour (RGB) or truecolour+alpha (RGBA) images.
//
// Decoding covers the same ground as the original bake script: filters 0-4,
// colour types 0 (grey), 2 (RGB), 3 (palette), 4 (grey+alpha) and 6 (RGBA),
// non-interlaced, 8 bits per channel. Encoding is used to re-emit decoded
// records and to synthesize procedural source art.

import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

/**
 * Decode an 8-bit non-interlaced PNG into RGBA pixels.
 *
 * @param {Buffer|Uint8Array} buf
 * @returns {{ width: number, height: number, data: Uint8Array }} RGBA, 4 bytes per pixel.
 */
export function decodePng(buf) {
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== SIGNATURE[i]) throw new Error('png: not a PNG (bad signature)');
  }
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  let trns = null;
  const idat = [];
  let sawIhdr = false;
  while (off + 8 <= buf.length) {
    const length = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + length);
    if (type === 'IHDR') {
      if (data.length < 13) throw new Error('png: truncated IHDR');
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
      sawIhdr = true;
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + length;
  }
  if (!sawIhdr) throw new Error('png: IHDR chunk missing');
  if (width <= 0 || height <= 0) throw new Error(`png: invalid dimensions ${width}x${height}`);
  if (bitDepth !== 8) throw new Error(`png: bit depth ${bitDepth} unsupported (only 8)`);
  if (interlace !== 0) throw new Error('png: interlaced images unsupported');
  const channels = CHANNELS_BY_COLOR_TYPE[colorType];
  if (!channels) throw new Error(`png: colour type ${colorType} unsupported`);
  if (colorType === 3 && !palette) throw new Error('png: palette image without PLTE chunk');
  if (!idat.length) throw new Error('png: no IDAT data');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error('png: truncated image data');
  const out = new Uint8Array(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[pos++];
      const a = x >= channels ? out[row + x - channels] : 0;
      const b = y > 0 ? out[row - stride + x] : 0;
      const c = x >= channels && y > 0 ? out[row - stride + x - channels] : 0;
      let result;
      if (filter === 0) result = value;
      else if (filter === 1) result = value + a;
      else if (filter === 2) result = value + b;
      else if (filter === 3) result = value + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        result = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error(`png: filter ${filter} unsupported`);
      out[row + x] = result & 255;
    }
  }
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    let r;
    let g;
    let b;
    let a = 255;
    if (colorType === 0) {
      r = g = b = out[i];
    } else if (colorType === 2) {
      r = out[i * 3];
      g = out[i * 3 + 1];
      b = out[i * 3 + 2];
    } else if (colorType === 4) {
      r = g = b = out[i * 2];
      a = out[i * 2 + 1];
    } else if (colorType === 6) {
      r = out[i * 4];
      g = out[i * 4 + 1];
      b = out[i * 4 + 2];
      a = out[i * 4 + 3];
    } else {
      const p = out[i];
      r = palette[p * 3];
      g = palette[p * 3 + 1];
      b = palette[p * 3 + 2];
      a = trns && p < trns.length ? trns[p] : 255;
    }
    pixels[i * 4] = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = a;
  }
  return { width, height, data: pixels };
}

/**
 * Encode RGB or RGBA bytes as an 8-bit PNG.
 *
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array|Buffer} pixels RGB (3 bytes/px) or RGBA (4 bytes/px).
 * @param {{ alpha?: boolean }} [options] Defaults to RGBA when `pixels` is 4 bytes per pixel.
 * @returns {Buffer}
 */
export function encodePng(width, height, pixels, options = {}) {
  const alpha = options.alpha ?? pixels.length === width * height * 4;
  const channels = alpha ? 4 : 3;
  if (pixels.length !== width * height * channels) {
    throw new Error(
      `png: encode expected ${width * height * 3} (RGB) or ${width * height * 4} (RGBA) bytes for ${width}x${height} (got ${pixels.length})`,
    );
  }
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < stride; x++) raw[row + 1 + x] = pixels[y * stride + x];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
