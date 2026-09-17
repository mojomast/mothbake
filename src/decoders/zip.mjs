// Dependency-free ZIP reader: stored (method 0) and deflate (method 8) entries
// located through the end-of-central-directory record. Enough for engine
// result bundles that ship LUTs, shaders and metadata in one archive.

import zlib from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

/**
 * Read a ZIP archive into a Map of entry name -> Buffer.
 *
 * @param {Buffer|Uint8Array} buf
 * @returns {Map<string, Buffer>}
 */
export function unzip(buf) {
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip: end-of-central-directory record not found');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (off >= buf.length) throw new Error('zip: central directory offset is outside the archive');
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CENTRAL_SIGNATURE) {
      throw new Error(`zip: corrupt central directory entry ${n}`);
    }
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOffset = buf.readUInt32LE(off + 42);
    if (localOffset + 30 > buf.length) throw new Error('zip: local header offset is outside the archive');
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const comp = buf.subarray(start, start + compSize);
    if (method === 0) {
      files.set(name, Buffer.from(comp));
    } else if (method === 8) {
      const data = zlib.inflateRawSync(comp);
      if (uncompSize && data.length !== uncompSize) {
        throw new Error(`zip: ${name} inflated to ${data.length} bytes, expected ${uncompSize}`);
      }
      files.set(name, data);
    } else {
      throw new Error(`zip: compression method ${method} unsupported for ${name} (only stored/deflate)`);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}
