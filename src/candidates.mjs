// Candidate JSON v1 lives in <workspaceRoot>/candidates/<id>.json. Each record:
// { version: 1, id, kind: 'image'|'audio'|'material',
//   source: { path: workspace-relative path, sha256: lowercase SHA-256 hex },
//   result: { path, sha256 }, params: {}, parameterDelta: {}, backend: string,
//   provenance: {}, qualityReport: {}, favorite: boolean, rejected: boolean,
//   notes: string }.
// Paths name assets, not URLs. readAsset(id, 'source'|'result') returns verified
// Buffer bytes; list() skips malformed records and get() throws for malformed
// records (or returns null if absent). Writers prepare assets before indexing.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, mkdir, lstat, realpath, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { decodePng, crc32 } from './decoders/png.mjs';
import { decodeWav } from './decoders/wav.mjs';
import { decodeGif } from './decoders/gif.mjs';
import { verifyJpeg, verifyWebp, verifyMp3, verifyOgg } from './media-structure.mjs';

export const CANDIDATE_VERSION = 1;
export const MAX_CANDIDATE_JSON_BYTES = 1024 * 1024;
const MAX_ASSET_JSON_BYTES = 1024 * 1024;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const FORMATS = {
  image: new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']),
  audio: new Set(['.wav', '.mp3', '.ogg']),
  material: new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.json']),
};
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

function validJson(value, active = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || active.has(value)) return false;
  active.add(value);
  try {
    if (Array.isArray(value)) return value.every((item) => validJson(item, active));
    return plain(value) && Object.entries(value).every(([key, item]) => key !== '__proto__' && validJson(item, active));
  } finally { active.delete(value); }
}

export function validateCandidateId(id) {
  if (typeof id !== 'string' || !ID.test(id)) throw new TypeError('invalid candidate id');
  return id;
}

export function validateCandidatePath(file) {
  if (typeof file !== 'string' || !file || file.includes('\\') || file.includes('\0') ||
    file.startsWith('/') || /^[a-zA-Z]:/.test(file) ||
    file.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new TypeError('invalid candidate asset path');
  }
  return file;
}

function assetRecord(asset, kind) {
  if (!plain(asset) || Object.keys(asset).some((k) => !['path', 'sha256'].includes(k)) ||
    !HASH.test(asset.sha256 ?? '')) throw new TypeError('invalid candidate asset hash or record');
  validateCandidatePath(asset.path);
  if (!FORMATS[kind].has(path.posix.extname(asset.path).toLowerCase())) throw new TypeError('unsupported candidate asset format');
  return asset;
}

/** Validate and detach a complete v1 record; unknown fields are rejected. */
export function validateCandidate(value) {
  const fields = ['version', 'id', 'kind', 'source', 'result', 'params', 'parameterDelta',
    'backend', 'provenance', 'qualityReport', 'favorite', 'rejected', 'notes'];
  if (!plain(value) || fields.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !fields.includes(key)) || value.version !== CANDIDATE_VERSION ||
    !Object.hasOwn(FORMATS, value.kind)) throw new TypeError('invalid candidate version or shape');
  validateCandidateId(value.id);
  assetRecord(value.source, value.kind);
  assetRecord(value.result, value.kind);
  if (![value.params, value.parameterDelta, value.provenance, value.qualityReport].every(plain) ||
    ![value.params, value.parameterDelta, value.provenance, value.qualityReport].every((item) => validJson(item)) ||
    typeof value.backend !== 'string' || !value.backend ||
    typeof value.favorite !== 'boolean' || typeof value.rejected !== 'boolean' ||
    typeof value.notes !== 'string') throw new TypeError('invalid candidate fields');
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > MAX_CANDIDATE_JSON_BYTES ||
    Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`) > MAX_CANDIDATE_JSON_BYTES) {
    throw new TypeError('candidate JSON too large');
  }
  return JSON.parse(bytes.toString('utf8'));
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function readRegular(file, maxBytes) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('file is not regular or exceeds size limit');
    // stat() before read prevents unbounded reads for ordinary immutable files.
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) throw new Error('file exceeds size limit');
    return { bytes, stat };
  } finally { await handle.close(); }
}

function verifyPng(bytes) {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return false;
  let offset = 8;
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return false;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return false;
    offset = end;
    if (type === 'IEND') { ended = length === 0; break; }
  }
  if (!ended || offset !== bytes.length) return false;
  try { decodePng(bytes); return true; } catch { return false; }
}

function verifyWav(bytes) {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) return false;
  let offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) return false;
    const size = bytes.readUInt32LE(offset + 4);
    offset += 8 + size + (size & 1);
    if (offset > bytes.length) return false;
  }
  try { const decoded = decodeWav(bytes); return decoded.frames > 0 && decoded.dataBytes === decoded.frames * decoded.channels * (decoded.bits / 8); }
  catch { return false; }
}

// PNG/GIF/WAV retain their existing decoder checks. Other formats receive
// bounded structural checks without interpreting compressed samples.
function mediaType(bytes, extension) {
  if (extension === '.json') {
    if (bytes.length > MAX_ASSET_JSON_BYTES) return false;
    try { JSON.parse(bytes.toString('utf8')); return true; } catch { return false; }
  }
  switch (extension) {
    case '.png': return verifyPng(bytes);
    case '.jpg': case '.jpeg': return verifyJpeg(bytes);
    case '.gif':
      try { decodeGif(bytes); return true; } catch { return false; }
    case '.webp': return verifyWebp(bytes);
    case '.wav': return verifyWav(bytes);
    case '.ogg': return verifyOgg(bytes);
    case '.mp3': return verifyMp3(bytes);
    default: return false;
  }
}

/** Async filesystem-backed candidate store. A missing candidates directory is empty. */
export function createCandidateStore({ workspaceRoot } = {}) {
  if (typeof workspaceRoot !== 'string' || !workspaceRoot) throw new TypeError('workspaceRoot is required');
  const root = path.resolve(workspaceRoot);
  const directory = path.join(root, 'candidates');
  let mutations = Promise.resolve();

  async function checkedDirectory(create = false) {
    const canonicalRoot = await realpath(root);
    if (create) await mkdir(directory, { recursive: true });
    let stat;
    try { stat = await lstat(directory); }
    catch (error) { if (!create && error.code === 'ENOENT') return null; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || !within(canonicalRoot, await realpath(directory))) {
      throw new Error('unsafe candidates directory');
    }
    return directory;
  }

  async function get(id) {
    validateCandidateId(id);
    if (!await checkedDirectory()) return null;
    const file = path.join(directory, `${id}.json`);
    try {
      const { bytes } = await readRegular(file, MAX_CANDIDATE_JSON_BYTES);
      const candidate = validateCandidate(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      if (candidate.id !== id) throw new Error('candidate id does not match filename');
      return candidate;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error(`corrupt candidate ${id}: ${error.message}`, { cause: error });
    }
  }

  async function list() {
    if (!await checkedDirectory()) return [];
    const entries = await readdir(directory);
    const candidates = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.json') || !ID.test(entry.slice(0, -5))) continue;
      try { const value = await get(entry.slice(0, -5)); if (value) candidates.push(value); }
      catch { /* A corrupt record cannot poison the whole index. */ }
    }
    return candidates;
  }

  async function readAsset(id, role) {
    if (role !== 'source' && role !== 'result') throw new TypeError('invalid candidate asset role');
    const candidate = await get(id);
    if (!candidate) return null;
    const asset = candidate[role];
    const canonicalRoot = await realpath(root);
    const file = path.resolve(root, ...asset.path.split('/'));
    if (!within(root, file)) throw new Error('candidate asset escapes workspace');
    const canonicalFile = await realpath(file);
    if (!within(canonicalRoot, canonicalFile)) throw new Error('candidate asset escapes workspace');
    const extension = path.posix.extname(asset.path).toLowerCase();
    const { bytes, stat } = await readRegular(canonicalFile, extension === '.json' ? MAX_ASSET_JSON_BYTES : 256 * 1024 * 1024);
    const latest = await realpath(file);
    const latestStat = await lstat(latest);
    if (latest !== canonicalFile || latestStat.dev !== stat.dev || latestStat.ino !== stat.ino ||
      !within(canonicalRoot, latest)) throw new Error('candidate asset changed during read');
    if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256 || !mediaType(bytes, extension)) {
      throw new Error('candidate asset hash or media format mismatch');
    }
    return bytes;
  }

  async function addCandidate(candidate) {
    const value = validateCandidate(candidate);
    await checkedDirectory(true);
    const file = path.join(directory, `${value.id}.json`);
    const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); }
    catch (error) { await unlink(file); throw error; }
    finally { await handle.close(); }
    return value;
  }

  function mutateMetadata(id, patch) {
    validateCandidateId(id);
    if (!plain(patch) || Object.keys(patch).some((key) => !['favorite', 'rejected', 'notes'].includes(key)) ||
      (Object.hasOwn(patch, 'favorite') && typeof patch.favorite !== 'boolean') ||
      (Object.hasOwn(patch, 'rejected') && typeof patch.rejected !== 'boolean') ||
      (Object.hasOwn(patch, 'notes') && typeof patch.notes !== 'string')) {
      throw new TypeError('invalid candidate metadata');
    }
    const task = mutations.then(async () => {
      const previous = await get(id);
      if (!previous) return null;
      const next = validateCandidate({ ...previous, ...patch });
      const file = path.join(directory, `${id}.json`);
      const temp = path.join(directory, `.${id}.${randomUUID()}.tmp`);
      try {
        const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`); }
        finally { await handle.close(); }
        // Refuse a swapped symlink before replacing the record.
        if (!(await lstat(file)).isFile()) throw new Error('candidate record changed during mutation');
        await rename(temp, file);
      } finally { await unlink(temp).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
      return next;
    });
    mutations = task.catch(() => {});
    return task;
  }

  return { list, get, readAsset, addCandidate, mutateMetadata };
}
