// Dependency-free Radiance RGBE (.hdr) decoder. Handles flat scanlines and the
// modern per-channel RLE encoding used by most HDR exporters.
//
// Decoded values are linear RGB floats in scanline order (top to bottom).

/**
 * @param {Buffer|Uint8Array} buf
 * @returns {{ width: number, height: number, data: Float32Array }} Linear RGB floats.
 */
export function decodeHdr(buf) {
  let pos = 0;
  const readLine = () => {
    let end = pos;
    while (end < buf.length && buf[end] !== 10) end++;
    const line = buf.toString('ascii', pos, end);
    pos = end + 1;
    return line;
  };
  if (!readLine().startsWith('#?')) throw new Error('hdr: not a Radiance HDR file');
  // Skip the header: "#?..." followed by zero or more comment lines, then a
  // blank line, then the resolution line.
  for (;;) {
    if (pos >= buf.length) throw new Error('hdr: header truncated before resolution line');
    const line = readLine();
    if (line === '') break;
  }
  const dims = readLine().match(/-Y\s+(\d+)\s+\+X\s+(\d+)/);
  if (!dims) throw new Error('hdr: resolution line (-Y h +X w) missing');
  const height = Number(dims[1]);
  const width = Number(dims[2]);
  if (!width || !height) throw new Error(`hdr: invalid dimensions ${width}x${height}`);
  const data = buf.subarray(pos);
  const out = new Float32Array(width * height * 3);
  const scan = new Uint8Array(width * 4);
  const isRle = (offset) =>
    width >= 8 &&
    width < 32768 &&
    data[offset] === 2 &&
    data[offset + 1] === 2 &&
    ((data[offset + 2] << 8) | data[offset + 3]) === width;
  let off = 0;
  for (let y = 0; y < height; y++) {
    if (isRle(off)) {
      off += 4;
      for (let channel = 0; channel < 4; channel++) {
        let x = 0;
        while (x < width) {
          const count = data[off++];
          if (count === undefined) throw new Error('hdr: truncated RLE data');
          if (count > 128) {
            const value = data[off++];
            for (let k = 0; k < count - 128; k++) scan[x++ * 4 + channel] = value;
          } else {
            for (let k = 0; k < count; k++) scan[x++ * 4 + channel] = data[off++];
          }
        }
      }
    } else {
      for (let i = 0; i < width * 4; i++) {
        if (off >= data.length) throw new Error('hdr: truncated flat scanline');
        scan[i] = data[off++];
      }
    }
    for (let x = 0; x < width; x++) {
      const r = scan[x * 4];
      const g = scan[x * 4 + 1];
      const b = scan[x * 4 + 2];
      const e = scan[x * 4 + 3];
      const index = (y * width + x) * 3;
      if (e === 0) {
        out[index] = out[index + 1] = out[index + 2] = 0;
      } else {
        const scale = Math.pow(2, e - 136);
        out[index] = r * scale;
        out[index + 1] = g * scale;
        out[index + 2] = b * scale;
      }
    }
  }
  return { width, height, data: out };
}
