// Bounded structural checks for formats without in-process decoders. These
// inspect framing and lengths, not compressed pixel/sample contents.
const bytesLike = (b) => Buffer.isBuffer(b) || b instanceof Uint8Array;
const text = (b, a, z) => Buffer.from(b.buffer, b.byteOffset + a, z - a).toString('ascii');

export function verifyJpeg(b) {
  if (!bytesLike(b) || b.length < 10 || b[0] !== 0xff || b[1] !== 0xd8) return false;
  let p = 2, frame = false, scan = false, entropy = false;
  while (p < b.length) {
    if (b[p++] !== 0xff) return false;
    while (p < b.length && b[p] === 0xff) p++;
    if (p >= b.length) return false;
    const marker = b[p++];
    if (marker === 0x00) { if (!entropy) return false; continue; }
    if (marker === 0xd9) return frame && scan && p === b.length;
    if (marker === 0xd8 || marker === 0x01) return false;
    if (marker >= 0xd0 && marker <= 0xd7) {
      if (!entropy) return false;
      while (p < b.length && b[p] !== 0xff) p++;
      continue;
    }
    if (p + 2 > b.length) return false;
    const length = (b[p] << 8) | b[p + 1];
    if (length < 2 || p + length > b.length) return false;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 11 || !b[p + 2] || !(b[p + 3] | b[p + 4]) || !(b[p + 5] | b[p + 6]) || !b[p + 7] || length !== 8 + 3 * b[p + 7]) return false;
      frame = true;
    }
    if (marker === 0xda) {
      if (!frame || length < 6 || !b[p + 2] || length !== 6 + 2 * b[p + 2]) return false;
      scan = true;
      entropy = true;
    } else entropy = false;
    p += length;
    if (entropy) {
      while (p < b.length && b[p] !== 0xff) p++;
    }
  }
  return false;
}

function webpPayload(b, a, z, type) {
  if (type === 'VP8 ') {
    return z - a >= 10 && !(b[a] & 1) && b[a + 3] === 0x9d && b[a + 4] === 0x01 && b[a + 5] === 0x2a &&
      !!((b[a + 6] | b[a + 7] << 8) & 0x3fff) && !!((b[a + 8] | b[a + 9] << 8) & 0x3fff);
  }
  if (type === 'VP8L') return z - a >= 5 && b[a] === 0x2f && (b[a + 4] & 0xe0) === 0;
  return false;
}

export function verifyWebp(b) {
  if (!bytesLike(b) || b.length < 20 || text(b, 0, 4) !== 'RIFF' || text(b, 8, 12) !== 'WEBP' ||
    b[4] + b[5] * 256 + b[6] * 65536 + b[7] * 16777216 + 8 !== b.length) return false;
  let p = 12, image = false, extended = false, animated = false;
  while (p < b.length) {
    if (p + 8 > b.length) return false;
    const type = text(b, p, p + 4);
    const size = b[p + 4] + b[p + 5] * 256 + b[p + 6] * 65536 + b[p + 7] * 16777216;
    const a = p + 8, z = a + size;
    if (z > b.length || z + (size & 1) > b.length) return false;
    if (p === 12) {
      if (type === 'VP8X') {
        if (size !== 10 || (b[a] & 0xc1) || b[a + 1] || b[a + 2] || b[a + 3]) return false;
        extended = true;
        animated = !!(b[a] & 0x02);
      } else if (!webpPayload(b, a, z, type)) return false;
      else image = true;
    } else if (!extended) return false;
    else if (type === 'VP8 ' || type === 'VP8L') {
      if (animated || image || !webpPayload(b, a, z, type)) return false;
      image = true;
    } else if (type === 'ANMF' && animated) {
      if (size < 24) return false;
      const inner = a + 16;
      const kind = text(b, inner, inner + 4);
      const len = b[inner + 4] + b[inner + 5] * 256 + b[inner + 6] * 65536 + b[inner + 7] * 16777216;
      if (inner + 8 + len + (len & 1) !== z || !webpPayload(b, inner + 8, inner + 8 + len, kind)) return false;
      image = true;
    }
    p = z + (size & 1);
  }
  return p === b.length && image;
}

const rates = [44100, 48000, 32000];
const bitrates = {
  '3:1': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '3:2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '3:3': [0, 32, 64, 96, 128, 160, 192, 224, 256, 320, 384, 448],
  '2:1': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2:2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2:3': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
};
export function verifyMp3(b) {
  if (!bytesLike(b)) return false;
  let p = 0;
  if (b.length >= 10 && text(b, 0, 3) === 'ID3') {
    if (b[3] < 2 || b[3] > 4 || b[4] === 0xff || (b[6] | b[7] | b[8] | b[9]) & 0x80) return false;
    p = 10 + (b[6] * 2097152 + b[7] * 16384 + b[8] * 128 + b[9]) + ((b[5] & 0x10) ? 10 : 0);
  }
  let frames = 0;
  while (p + 4 <= b.length) {
    if (p + 128 === b.length && text(b, p, p + 3) === 'TAG' && frames) return true;
    const h = (b[p] * 0x1000000 + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3]) >>> 0;
    const version = (h >>> 19) & 3, layer = (h >>> 17) & 3, rateIndex = (h >>> 10) & 3;
    const bitrateIndex = (h >>> 12) & 15;
    if (((h & 0xffe00000) >>> 0) !== 0xffe00000 || version === 1 || !layer || rateIndex === 3 ||
      !bitrateIndex || bitrateIndex === 15) return false;
    const rate = rates[rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const kbps = bitrates[`${version === 3 ? 3 : 2}:${layer}`][bitrateIndex];
    const length = layer === 3 ? Math.floor(12 * kbps * 1000 / rate + ((h >>> 9) & 1)) * 4 :
      Math.floor((layer === 1 && version !== 3 ? 72 : 144) * kbps * 1000 / rate + ((h >>> 9) & 1));
    if (length < 4 || p + length > b.length) return false;
    p += length;
    frames++;
  }
  return frames > 0 && p === b.length;
}

const oggTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let v = i << 24;
    for (let j = 0; j < 8; j++) v = ((v << 1) ^ ((v & 0x80000000) ? 0x04c11db7 : 0)) >>> 0;
    table[i] = v;
  }
  return table;
})();
export function verifyOgg(b) {
  if (!bytesLike(b)) return false;
  let p = 0, pages = 0, eos = false, serial, sequence, packet = [];
  while (p < b.length) {
    if (p + 27 > b.length || text(b, p, p + 4) !== 'OggS' || b[p + 4] !== 0 || (b[p + 5] & ~7)) return false;
    const count = b[p + 26];
    if (p + 27 + count > b.length) return false;
    let size = 0;
    for (let i = 0; i < count; i++) size += b[p + 27 + i];
    const end = p + 27 + count + size;
    if (end > b.length || eos) return false;
    const s = b[p + 14] + b[p + 15] * 256 + b[p + 16] * 65536 + b[p + 17] * 16777216;
    const seq = b[p + 18] + b[p + 19] * 256 + b[p + 20] * 65536 + b[p + 21] * 16777216;
    if (pages ? s !== serial || seq !== ((sequence + 1) >>> 0) || !!(b[p + 5] & 1) !== !!packet.length :
      !(b[p + 5] & 2) || (b[p + 5] & 1)) return false;
    const expected = (b[p + 22] + b[p + 23] * 256 + b[p + 24] * 65536 + b[p + 25] * 16777216) >>> 0;
    let crc = 0;
    for (let i = p; i < end; i++) crc = ((crc << 8) ^ oggTable[((crc >>> 24) ^ (i >= p + 22 && i < p + 26 ? 0 : b[i])) & 255]) >>> 0;
    if (crc !== expected) return false;
    let data = p + 27 + count;
    for (let i = 0; i < count; i++) {
      const n = b[p + 27 + i];
      if (pages === 0 && packet.length < 8) for (let j = 0; j < n && packet.length < 8; j++) packet.push(b[data + j]);
      data += n;
    }
    if (!pages && !(String.fromCharCode(...packet) === 'OpusHead' ||
      (packet[0] === 1 && String.fromCharCode(...packet.slice(1, 7)) === 'vorbis'))) return false;
    // Continuation is determined by the last lacing value, not packet bytes.
    packet = count && b[p + 26 + count] === 255 ? [1] : [];
    eos = !!(b[p + 5] & 4);
    serial = s; sequence = seq; pages++; p = end;
  }
  return pages > 0 && eos && packet.length === 0;
}

/** Dispatch a bounded structural check by lowercase extension. */
export function verifyMediaStructure(bytes, extension) {
  const ext = String(extension).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return verifyJpeg(bytes);
  if (ext === '.webp') return verifyWebp(bytes);
  if (ext === '.mp3') return verifyMp3(bytes);
  if (ext === '.ogg' || ext === '.oga' || ext === '.opus') return verifyOgg(bytes);
  throw new TypeError(`unsupported structural media extension: ${extension}`);
}
