// Dependency-free ZIP reader and writer.
//
// `unzip()` reads stored (method 0) and deflate (method 8) entries located
// through the end-of-central-directory record — enough for engine result
// bundles that ship LUTs, shaders and metadata in one archive.
//
// `zip()` writes a deterministic classic ZIP archive from a set of entries,
// choosing stored or deflate per entry, so bundles built for engine upload can
// be read back with `unzip()` (and by any standard tool).

import zlib from 'node:zlib';
import { crc32 } from './png.mjs';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_CLASSIC = 0xffffffff;
// Fixed MS-DOS epoch (1980-01-01 00:00) keeps archives byte-deterministic.
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;

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

/** Normalize the many entry shapes `zip()` accepts into `[name, Buffer]` pairs. */
function normalizeEntries(entries) {
  const pairs = [];
  const push = (name, data) => {
    if (typeof name !== 'string' || !name) throw new Error('zip: entry names must be non-empty strings');
    const buffer = data === undefined || data === null
      ? Buffer.alloc(0)
      : Buffer.isBuffer(data)
        ? data
        : typeof data === 'string'
          ? Buffer.from(data, 'utf8')
          : Buffer.from(data);
    pairs.push([name, buffer]);
  };
  if (entries instanceof Map) {
    for (const [name, data] of entries) push(name, data);
  } else if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (Array.isArray(entry)) push(entry[0], entry[1]);
      else if (entry && typeof entry === 'object') push(entry.name, entry.data);
      else throw new Error('zip: array entries must be [name, data] pairs or { name, data } objects');
    }
  } else if (entries && typeof entries === 'object') {
    for (const [name, data] of Object.entries(entries)) push(name, data);
  } else {
    throw new Error('zip: entries must be a Map, object, or array of entries');
  }
  if (!pairs.length) throw new Error('zip: no entries to write');
  return pairs;
}

/**
 * Write a deterministic classic ZIP archive.
 *
 * @param {Map<string, Buffer|Uint8Array|string>|object|Array} entries
 * @param {{ method?: 'store'|'deflate'|'auto' }} [options] `auto` (default)
 *   deflates each entry but falls back to stored when deflate does not shrink it.
 * @returns {Buffer}
 */
export function zip(entries, options = {}) {
  const { method = 'auto' } = options;
  if (!['store', 'deflate', 'auto'].includes(method)) {
    throw new Error(`zip: unknown method "${method}" (expected store, deflate or auto)`);
  }
  const pairs = normalizeEntries(entries);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const [name, raw] of pairs) {
    const nameBytes = Buffer.from(name, 'utf8');
    const utf8 = nameBytes.length !== name.length;
    const crc = crc32(raw);
    let compression = method === 'auto' ? 8 : method === 'deflate' ? 8 : 0;
    let payload = raw;
    if (compression === 8) {
      const deflated = zlib.deflateRawSync(raw, { level: 9 });
      if (method === 'auto' && deflated.length >= raw.length) {
        compression = 0;
        payload = raw;
      } else {
        payload = deflated;
      }
    }
    if (raw.length > MAX_CLASSIC || payload.length > MAX_CLASSIC || offset > MAX_CLASSIC) {
      throw new Error(`zip: "${name}" makes the archive too large for the classic format (ZIP64 is not supported)`);
    }
    const flags = utf8 ? 0x0800 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(compression, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(compression, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);

    offset += 30 + nameBytes.length + payload.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  if (offset > MAX_CLASSIC || centralSize > MAX_CLASSIC) {
    throw new Error('zip: archive too large for the classic format (ZIP64 is not supported)');
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(pairs.length, 8);
  eocd.writeUInt16LE(pairs.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

export default unzip;
