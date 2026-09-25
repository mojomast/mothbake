// Versioned directory publication with an atomic JSON pointer. Consumers read
// current.json, then the immutable version directory it names. Failed builds or
// validation never change the current pointer; completed older versions remain
// available for rollback.

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileAtomic } from './publish.mjs';

// v2 pins the complete bytes of every published version used for reuse/rollback.
export const PACK_POINTER_VERSION = 2;
const VERSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function realDirectory(directory, label, create = false) {
  if (create) {
    try { fs.mkdirSync(directory); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe pack ${label} directory`);
  return directory;
}

function versionDirectory(root, id) {
  const directory = path.join(root, '.versions', id);
  try { realDirectory(directory, 'version'); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`pack version is missing: ${id}`);
    throw error;
  }
  return directory;
}

function pointerFile(root) {
  const file = path.join(root, 'current.json');
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error('unsafe pack pointer file');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return file;
}

function assertRoot(root) {
  const resolved = path.resolve(root);
  fs.mkdirSync(resolved, { recursive: true });
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('pack root must be a real directory');
  return resolved;
}

function readPointer(root) {
  const file = pointerFile(root);
  if (!fs.existsSync(file)) return null;
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { throw new Error(`pack pointer is corrupt: ${error.message}`); }
  if (!value || value.version !== PACK_POINTER_VERSION || !VERSION_ID.test(value.currentVersion)
    || (value.previousVersion !== null && !VERSION_ID.test(value.previousVersion))
    || !value.contentHashes || typeof value.contentHashes !== 'object' || Array.isArray(value.contentHashes)
    || Object.entries(value.contentHashes).some(([id, digest]) => !VERSION_ID.test(id) || !SHA256.test(digest))
    || !Object.hasOwn(value.contentHashes, value.currentVersion)
    || (value.previousVersion && !Object.hasOwn(value.contentHashes, value.previousVersion))) throw new Error('pack pointer has an unsupported shape');
  return value;
}

// Diagnostic-only inspection: unlike assertRoot/readPointer this never creates
// directories or attempts to repair/migrate a pointer. Values are reported as
// found, with issues explaining why strict consumers would reject them.
export function inspectPointerShape(rawRoot) {
  const root = path.resolve(rawRoot);
  const issues = [];
  let rootStat;
  try { rootStat = fs.lstatSync(root); }
  catch (error) {
    if (error.code === 'ENOENT') return { issues: ['pack root is missing'], hasContentHashes: false, current: null, previous: null };
    return { issues: [`cannot inspect pack root: ${error.message}`], hasContentHashes: false, current: null, previous: null };
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { issues: ['pack root is not a real directory'], hasContentHashes: false, current: null, previous: null };
  const file = path.join(root, 'current.json');
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error.code === 'ENOENT') return { issues: ['pointer is missing'], hasContentHashes: false, current: null, previous: null };
    return { issues: [`cannot inspect pointer: ${error.message}`], hasContentHashes: false, current: null, previous: null };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return { issues: ['pointer is not a regular file'], hasContentHashes: false, current: null, previous: null };
  if (stat.size > 1024 * 1024) return { issues: ['pointer exceeds size limit'], hasContentHashes: false, current: null, previous: null };
  let text;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > 1024 * 1024) throw new Error('pointer changed during inspection');
    const data = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < data.length) {
      const count = fs.readSync(fd, data, offset, data.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    text = data.subarray(0, offset).toString('utf8');
  } catch (error) { return { issues: [`cannot read pointer: ${error.message}`], hasContentHashes: false, current: null, previous: null }; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  let value;
  try { value = JSON.parse(text); }
  catch (error) { return { issues: [`pointer is corrupt: ${error.message}`], hasContentHashes: false, current: null, previous: null }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { issues: ['pointer is not an object'], hasContentHashes: false, current: null, previous: null };
  const hasContentHashes = !!value.contentHashes && typeof value.contentHashes === 'object' && !Array.isArray(value.contentHashes);
  const result = { issues, hasContentHashes, current: value.currentVersion ?? null, previous: value.previousVersion ?? null };
  if (value.version === 1) issues.push('v1-shaped pointer is unsupported; migration is deferred');
  else if (value.version !== PACK_POINTER_VERSION) issues.push('unsupported pointer version');
  if (!VERSION_ID.test(value.currentVersion ?? '')) issues.push('invalid currentVersion');
  if (!Object.hasOwn(value, 'previousVersion')) issues.push('previousVersion is missing');
  if (value.previousVersion !== null && value.previousVersion !== undefined && !VERSION_ID.test(value.previousVersion)) issues.push('invalid previousVersion');
  if (!hasContentHashes) issues.push('contentHashes is missing or invalid');
  else {
    if (Object.entries(value.contentHashes).some(([id, digest]) => !VERSION_ID.test(id) || typeof digest !== 'string' || !SHA256.test(digest))) issues.push('contentHashes contains invalid entries');
    if (!Object.hasOwn(value.contentHashes, value.currentVersion) || (value.previousVersion && !Object.hasOwn(value.contentHashes, value.previousVersion))) issues.push('contentHashes does not pin current/previous versions');
  }
  return result;
}

function validateTree(root, options = {}) {
  const maxFiles = options.maxFiles ?? 10_000;
  const maxBytes = options.maxBytes ?? 1024 * 1024 * 1024;
  let files = 0, bytes = 0;
  const fingerprint = createHash('sha256');
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const target = path.join(dir, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error(`pack contains a symlink: ${path.relative(root, target)}`);
      if (stat.isDirectory()) {
        fingerprint.update(JSON.stringify(['directory', path.relative(root, target)]));
        walk(target);
      }
      else if (stat.isFile()) {
        files += 1;
        bytes += stat.size;
        if (files > maxFiles || bytes > maxBytes) throw new Error('pack exceeds file or byte limit');
        const fileHash = createHash('sha256');
        const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const opened = fs.fstatSync(fd);
          if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) {
            throw new Error('pack file changed during validation');
          }
          const chunk = Buffer.allocUnsafe(64 * 1024);
          let count;
          while ((count = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) fileHash.update(chunk.subarray(0, count));
          if (fs.fstatSync(fd).size !== stat.size) throw new Error('pack file changed during validation');
        } finally { fs.closeSync(fd); }
        fingerprint.update(JSON.stringify(['file', path.relative(root, target), stat.size, fileHash.digest('hex')]));
      } else throw new Error(`pack contains unsupported entry: ${path.relative(root, target)}`);
    }
  };
  walk(root);
  return { files, bytes, sha256: fingerprint.digest('hex') };
}

function checkedVersion(root, id, expected, options) {
  const directory = versionDirectory(root, id);
  const metrics = validateTree(directory, options);
  if (!expected || metrics.sha256 !== expected) throw new Error(`pack version content identity mismatch: ${id}`);
  return { directory, metrics };
}

export async function publishPackVersion(options = {}) {
  const { root: rawRoot, versionId, build, validate = () => {}, failpoint = () => {} } = options;
  if (!VERSION_ID.test(versionId ?? '')) throw new TypeError('invalid pack version id');
  if (typeof build !== 'function' || typeof validate !== 'function') throw new TypeError('pack build and validate functions are required');
  const root = assertRoot(rawRoot);
  const versions = path.join(root, '.versions');
  const stagingRoot = path.join(root, '.staging');
  realDirectory(versions, 'administration', true);
  realDirectory(stagingRoot, 'administration', true);
  const prior = readPointer(root);
  const target = path.join(versions, versionId);
  // lstat also catches dangling symlinks, which existsSync silently ignores.
  let targetExists = false;
  try { fs.lstatSync(target); targetExists = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (targetExists) {
    if (!options.reuseExisting) throw new Error(`pack version already exists: ${versionId}`);
    const { metrics } = checkedVersion(root, versionId, prior?.contentHashes[versionId], options);
    // A pinned old version is not sufficient: the caller may request different
    // bytes under the same explicit version ID. Build the request independently
    // and compare the complete trees before repointing.
    const requested = path.join(stagingRoot, `${versionId}.${randomUUID()}`);
    fs.mkdirSync(requested);
    try {
      await build(requested);
      const requestedMetrics = validateTree(requested, options);
      await validate(requested, requestedMetrics);
      if (validateTree(requested, options).sha256 !== metrics.sha256) {
        throw new Error(`pack version requested content identity mismatch: ${versionId}`);
      }
      await validate(target, metrics);
      checkedVersion(root, versionId, metrics.sha256, options);
    } finally { fs.rmSync(requested, { recursive: true, force: true }); }
    const pointer = {
      version: PACK_POINTER_VERSION,
      currentVersion: versionId,
      previousVersion: prior?.currentVersion === versionId ? prior.previousVersion : prior?.currentVersion ?? null,
      contentHashes: prior.contentHashes,
    };
    writeFileAtomic(pointerFile(root), `${JSON.stringify(pointer, null, 2)}\n`);
    return { root, directory: target, pointer, metrics, reused: true };
  }
  const staging = path.join(stagingRoot, `${versionId}.${randomUUID()}`);
  fs.mkdirSync(staging, { recursive: false });
  let promotedVersion = false;
  let pointerWritten = false;
  try {
    await build(staging);
    failpoint('after-build', staging);
    const metrics = validateTree(staging, options);
    await validate(staging, metrics);
    failpoint('after-validate', staging);
    // The validator may have changed files; pin the final complete tree.
    const finalMetrics = validateTree(staging, options);
    fs.renameSync(staging, target);
    promotedVersion = true;
    failpoint('before-pointer', target);
    checkedVersion(root, versionId, finalMetrics.sha256, options);
    const pointer = {
      version: PACK_POINTER_VERSION,
      currentVersion: versionId,
      previousVersion: prior?.currentVersion ?? null,
      contentHashes: { ...prior?.contentHashes, [versionId]: finalMetrics.sha256 },
    };
    writeFileAtomic(pointerFile(root), `${JSON.stringify(pointer, null, 2)}\n`);
    pointerWritten = true;
    failpoint('after-pointer', target);
    return { root, directory: target, pointer, metrics };
  } catch (error) {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    if (pointerWritten) {
      if (prior) writeFileAtomic(pointerFile(root), `${JSON.stringify(prior, null, 2)}\n`);
      else fs.rmSync(pointerFile(root), { force: true });
    }
    if (promotedVersion && fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

export function resolveCurrentPack(root) {
  const resolved = assertRoot(root);
  const pointer = readPointer(resolved);
  if (!pointer) return null;
  realDirectory(path.join(resolved, '.versions'), 'administration');
  const { directory } = checkedVersion(resolved, pointer.currentVersion, pointer.contentHashes[pointer.currentVersion]);
  return { pointer, directory };
}

export function rollbackPack(root, versionId = null) {
  const resolved = assertRoot(root);
  const prior = readPointer(resolved);
  if (!prior) throw new Error('pack has no current version');
  const targetVersion = versionId ?? prior.previousVersion;
  if (!targetVersion || !VERSION_ID.test(targetVersion)) throw new Error('pack has no rollback target');
  realDirectory(path.join(resolved, '.versions'), 'administration');
  checkedVersion(resolved, targetVersion, prior.contentHashes[targetVersion]);
  const pointer = { version: PACK_POINTER_VERSION, currentVersion: targetVersion, previousVersion: prior.currentVersion, contentHashes: prior.contentHashes };
  writeFileAtomic(pointerFile(resolved), `${JSON.stringify(pointer, null, 2)}\n`);
  return pointer;
}
