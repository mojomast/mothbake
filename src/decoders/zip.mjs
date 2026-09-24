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
const DEFAULT_LIMITS = {
  maxEntries: 4096,
  maxEntryUncompressedBytes: 64 * 1024 * 1024,
  maxTotalUncompressedBytes: 256 * 1024 * 1024,
};
// Fixed MS-DOS epoch (1980-01-01 00:00) keeps archives byte-deterministic.
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;

/**
 * Read a ZIP archive into a Map of entry name -> Buffer.
 *
 * @param {Buffer|Uint8Array} buf
 * @param {{ maxEntries?: number, maxEntryUncompressedBytes?: number, maxTotalUncompressedBytes?: number }} [options]
 *   Resource limits (defaults: 4096 entries, 64 MiB per entry, 256 MiB total).
 * @returns {Map<string, Buffer>}
 */
export function unzip(buf, options = {}) {
  if (!(buf instanceof Uint8Array)) throw new TypeError('zip: expected a Buffer or Uint8Array');
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const limits = Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([key, value]) => [key, options?.[key] ?? value]));
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`zip: ${key} must be a non-negative safe integer`);
  }
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE && i + 22 + buf.readUInt16LE(i + 20) === buf.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip: end-of-central-directory record not found');
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0 ||
      buf.readUInt16LE(eocd + 8) !== buf.readUInt16LE(eocd + 10)) {
    throw new Error('zip: multi-disk archives are unsupported');
  }
  const count = buf.readUInt16LE(eocd + 10);
  if (count > limits.maxEntries) throw new Error(`zip: entry count ${count} exceeds maxEntries=${limits.maxEntries}`);
  let off = buf.readUInt32LE(eocd + 16);
  const centralStart = off;
  const centralEnd = off + buf.readUInt32LE(eocd + 12);
  if (off > eocd || centralEnd > eocd) throw new Error('zip: central directory is outside the archive');
  const files = new Map();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (off + 46 > centralEnd || buf.readUInt32LE(off) !== CENTRAL_SIGNATURE) {
      throw new Error(`zip: corrupt central directory entry ${n}`);
    }
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const expectedCrc = buf.readUInt32LE(off + 16);
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOffset = buf.readUInt32LE(off + 42);
    const next = off + 46 + nameLen + extraLen + commentLen;
    if (next > centralEnd) throw new Error(`zip: corrupt central directory entry ${n} name or extra data`);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (!name || name.includes('\0') || name.startsWith('/') || name.startsWith('\\') ||
        /^[a-zA-Z]:/.test(name) || name.split(/[/\\]/).some((part) => part === '..' || part === '.')) {
      throw new Error(`zip: unsafe entry name ${JSON.stringify(name)}`);
    }
    if (flags & 1) throw new Error(`zip: encrypted entry unsupported for ${name}`);
    if (uncompSize > limits.maxEntryUncompressedBytes) {
      throw new Error(`zip: ${name} exceeds maxEntryUncompressedBytes=${limits.maxEntryUncompressedBytes}`);
    }
    total += uncompSize;
    if (total > limits.maxTotalUncompressedBytes) {
      throw new Error(`zip: archive exceeds maxTotalUncompressedBytes=${limits.maxTotalUncompressedBytes}`);
    }
    if (localOffset + 30 > centralStart || buf.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`zip: invalid local header for ${name}`);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    if (start > centralStart || start + compSize > centralStart ||
        localNameLen !== nameLen || !buf.subarray(localOffset + 30, localOffset + 30 + localNameLen).equals(buf.subarray(off + 46, off + 46 + nameLen)) ||
        buf.readUInt16LE(localOffset + 8) !== method || buf.readUInt16LE(localOffset + 6) !== flags) {
      throw new Error(`zip: local header mismatch or truncated payload for ${name}`);
    }
    // Data descriptors allow placeholder sizes and CRC in the local header.
    if ((!(flags & 8) && (buf.readUInt32LE(localOffset + 14) !== expectedCrc ||
        buf.readUInt32LE(localOffset + 18) !== compSize || buf.readUInt32LE(localOffset + 22) !== uncompSize)) ||
        ((flags & 8) && ((buf.readUInt32LE(localOffset + 14) !== 0 && buf.readUInt32LE(localOffset + 14) !== expectedCrc) ||
          (buf.readUInt32LE(localOffset + 18) !== 0 && buf.readUInt32LE(localOffset + 18) !== compSize) ||
          (buf.readUInt32LE(localOffset + 22) !== 0 && buf.readUInt32LE(localOffset + 22) !== uncompSize)))) {
      throw new Error(`zip: local header sizes or CRC mismatch for ${name}`);
    }
    const comp = buf.subarray(start, start + compSize);
    let data;
    if (method === 0) {
      data = Buffer.from(comp);
    } else if (method === 8) {
      // The extra byte catches forged zero/undersized headers without permitting unbounded inflation.
      data = zlib.inflateRawSync(comp, { maxOutputLength: Math.min(uncompSize + 1, limits.maxEntryUncompressedBytes + 1, limits.maxTotalUncompressedBytes - (total - uncompSize) + 1) });
    } else {
      throw new Error(`zip: compression method ${method} unsupported for ${name} (only stored/deflate)`);
    }
    if (data.length !== uncompSize) throw new Error(`zip: ${name} decoded to ${data.length} bytes, expected ${uncompSize}`);
    if (crc32(data) !== expectedCrc) throw new Error(`zip: CRC mismatch for ${name}`);
    files.set(name, data);
    off = next;
  }
  if (off !== centralEnd) throw new Error('zip: central directory size mismatch');
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
