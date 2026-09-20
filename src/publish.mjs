// Publication helpers for the emitter stage: atomic writes, exact-JSON
// validation and merge-safe publication of aggregate artifacts.
//
// The emitter stage is the last place baked data can be lost. A partial run
// (`--only`, disabled jobs) or a run with job failures produces only part of
// the records, and rewriting an aggregate artifact from that subset would drop
// everything a previous run published; a crash mid-write can corrupt a
// previously good file; and `JSON.stringify` silently mangles values that are
// not exactly representable (NaN/Infinity become null, `undefined` keys vanish,
// array holes become null, non-plain objects lose their identity).
//
// The mechanisms here are generic — they know nothing about buckets, record
// shapes or engines:
//
// - `writeFileAtomic(target, data)` writes through a same-directory temp file
//   and renames over the target, so readers never see a half-written artifact
//   and a failure leaves the previous file byte-identical.
// - `assertJsonSafe(value, label)` rejects every value JSON would not
//   round-trip exactly, with the path of the offending value.
// - `readJsonArtifact` / `readModuleArtifact` load a previously published
//   artifact. Missing is `null`; a present but broken artifact is an error, so
//   it is never silently overwritten.
// - `mergeRecordsIntoBundle`, `mergeBundles`, `mergeRecordLists` and
//   `mergeIndex` overlay this run's output on the previous one, key by key.
// - `validateForPublish` refuses to write an aggregate that is not exactly
//   JSON or that is missing provenance for a job whose records it carries.
//
// Merge is opt-in: an emitter only loads a previous artifact when its config
// sets `merge: true`, so a default run replaces its output exactly as before.
// Per-emitter rather than a run-wide flag because only the emitter knows the
// shape of its artifact and whether merging it is meaningful.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bundleRecords } from './bundle.mjs';

/** A plain JSON object (not an array, Buffer, class instance, …). */
export function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Write `data` (string or Buffer) through a same-directory temp file and rename
 * it over `target`. The parent directory is created on demand; on any failure
 * the temp file is removed and the previous target is untouched.
 */
export function writeFileAtomic(target, data) {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Keep the original error; the temp file may never have been created.
    }
    throw error;
  }
}

/**
 * Reject anything `JSON.stringify` would silently mangle: functions, symbols,
 * bigints, `undefined` values (dropped keys), array holes (null), non-finite
 * numbers (null), cycles and non-plain objects. Returns `value` so callers can
 * validate and serialize in one expression.
 */
export function assertJsonSafe(value, label = 'value') {
  const seen = new Set();
  const walk = (node, at) => {
    if (node === null || typeof node === 'string' || typeof node === 'boolean') return;
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) throw new Error(`${label}: ${at} is ${node}, which JSON would turn into null`);
      return;
    }
    if (typeof node !== 'object') {
      const what = node === undefined ? 'undefined' : `a ${typeof node}`;
      throw new Error(`${label}: ${at} is ${what}, which JSON cannot represent`);
    }
    if (seen.has(node)) throw new Error(`${label}: ${at} is a cycle`);
    seen.add(node);
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index++) {
        if (!(index in node)) throw new Error(`${label}: ${at}[${index}] is a hole, which JSON would turn into null`);
        walk(node[index], `${at}[${index}]`);
      }
    } else {
      if (!isPlainObject(node)) throw new Error(`${label}: ${at} is not a plain object, so JSON would not round-trip it`);
      for (const symbol of Object.getOwnPropertySymbols(node)) {
        if (Object.getOwnPropertyDescriptor(node, symbol).enumerable) {
          throw new Error(`${label}: ${at} has an enumerable symbol key, which JSON would drop`);
        }
      }
      for (const [key, child] of Object.entries(node)) {
        if (child === undefined) throw new Error(`${label}: ${at}.${key} is undefined, so JSON would drop it`);
        walk(child, `${at}.${key}`);
      }
    }
    seen.delete(node);
  };
  walk(value, '$');
  return value;
}

/**
 * Read a previously published JSON artifact. Returns `null` when it does not
 * exist; a present but unreadable or malformed artifact throws, so a corrupt
 * file is never silently replaced.
 */
export function readJsonArtifact(target, label = 'artifact') {
  if (!fs.existsSync(target)) return null;
  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (error) {
    throw new Error(`${label}: previous artifact is unreadable: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label}: previous artifact is not valid JSON: ${error.message}`);
  }
}

let importSeq = 0;

/**
 * Read a previously published ES module artifact. Tries the configured named
 * export first, then `default`. Returns `null` when the file does not exist.
 * The module is imported with a cache-busting query so repeated calls in one
 * process see the current file; a module that does not export the requested
 * binding throws rather than merging into an empty base.
 */
export async function readModuleArtifact(target, exportName = 'BAKED', label = 'artifact') {
  if (!fs.existsSync(target)) return null;
  let module;
  try {
    module = await import(`${pathToFileURL(target).href}?mothbake=${Date.now()}-${++importSeq}`);
  } catch (error) {
    throw new Error(`${label}: previous artifact could not be imported: ${error.message}`);
  }
  const value = module[exportName] ?? module.default;
  if (value === undefined) {
    throw new Error(`${label}: previous artifact does not export "${exportName}" or a default`);
  }
  return value;
}

/** Materialize a sparse frame array as explicit nulls, keeping positions. */
function denseFrames(frames) {
  return Array.from(frames, (frame) => frame ?? null);
}

/**
 * Merge one frame-shaped entry over a previous one: frames are addressed by
 * index, so a partial run cannot shift a later frame onto index 0. Previous
 * frames not written by this run are kept and trailing nulls are trimmed.
 */
function mergeEntry(previous, fresh) {
  if (!isPlainObject(previous) || !isPlainObject(fresh)) return fresh;
  if (!Array.isArray(previous.frames) || !Array.isArray(fresh.frames)) return fresh;
  const frames = denseFrames(previous.frames);
  for (let index = 0; index < fresh.frames.length; index++) {
    const frame = fresh.frames[index];
    if (frame !== null && frame !== undefined) frames[index] = frame;
  }
  while (frames.length && frames[frames.length - 1] === null) frames.pop();
  return { ...fresh, frames };
}

/**
 * Merge a fresh bucket-shaped aggregate over a previous one, key by key:
 * entries this run did not write keep their previous value and frame entries
 * merge by index. Bucket order follows the previous artifact first-seen, then
 * any new buckets in fresh order.
 */
export function mergeBundles(previous, fresh) {
  if (!previous) return fresh;
  if (!fresh) return previous;
  if (!isPlainObject(previous) || !isPlainObject(fresh)) {
    throw new Error('mergeBundles: previous and fresh aggregates must be plain objects');
  }
  const merged = { ...previous, version: fresh.version ?? previous.version, generator: fresh.generator ?? previous.generator };
  for (const [key, freshValue] of Object.entries(fresh)) {
    if (key === 'version' || key === 'generator') continue;
    const previousValue = previous[key];
    if (isPlainObject(freshValue) && isPlainObject(previousValue)) {
      const entries = { ...previousValue };
      for (const [entryKey, entry] of Object.entries(freshValue)) {
        entries[entryKey] = mergeEntry(entries[entryKey], entry);
      }
      merged[key] = entries;
    } else {
      merged[key] = freshValue;
    }
  }
  return merged;
}

/**
 * Apply this run's records over a previously published bundle. Non-frame
 * records replace their own bucket+key; frame records replace one index and
 * keep every other index, so a partial effect run cannot lose frames. With no
 * previous bundle the result is exactly `bundleRecords(records, options)`.
 * `keepProvenance: false` replaces the provenance table instead of unioning it
 * (used when an emitter is configured with `provenance: false`).
 */
export function mergeRecordsIntoBundle(previous, records, options = {}) {
  const {
    version = previous?.version ?? 1,
    generator = previous?.generator ?? 'mothbake',
    provenance = {},
    keepProvenance = true,
  } = options;
  if (!previous) return bundleRecords(records, { version, generator, provenance });
  if (!isPlainObject(previous)) throw new Error('mergeRecordsIntoBundle: previous bundle must be a plain object');
  const table = keepProvenance ? { ...(isPlainObject(previous.provenance) ? previous.provenance : {}), ...provenance } : provenance;
  const merged = { ...previous, version, generator, provenance: table };
  for (const record of records) {
    const bucket = { ...(isPlainObject(merged[record.bucket]) ? merged[record.bucket] : {}) };
    if (record.merge === 'frames') {
      const prior = isPlainObject(bucket[record.key]) ? bucket[record.key] : {};
      const frames = Array.isArray(prior.frames) ? denseFrames(prior.frames) : [];
      const index = record.index ?? 0;
      while (frames.length <= index) frames.push(null);
      frames[index] = record.value;
      while (frames.length && frames[frames.length - 1] === null) frames.pop();
      bucket[record.key] = { ...prior, fps: record.fps ?? prior.fps ?? 10, frames };
    } else {
      bucket[record.key] = record.value;
    }
    merged[record.bucket] = bucket;
  }
  return merged;
}

/**
 * Merge a fresh flat record list over a previous one. Records are grouped by
 * bucket+key: a fresh group replaces the previous group, except frame groups,
 * which merge by index. Previous groups this run did not touch are appended.
 */
export function mergeRecordLists(previous, records) {
  if (!previous) return records;
  if (!Array.isArray(previous) || !Array.isArray(records)) {
    throw new Error('mergeRecordLists: previous and fresh records must be arrays');
  }
  const groupKey = (record) => `${record?.bucket}\u0000${record?.key}`;
  const groups = new Map();
  for (const record of previous) {
    const key = groupKey(record);
    if (groups.has(key)) groups.get(key).push(record);
    else groups.set(key, [record]);
  }
  const merged = [];
  const handled = new Set();
  for (const record of records) {
    const key = groupKey(record);
    if (handled.has(key)) continue;
    handled.add(key);
    const freshGroup = records.filter((candidate) => groupKey(candidate) === key);
    const priorGroup = groups.get(key);
    if (!priorGroup || !freshGroup.some((candidate) => candidate.merge === 'frames')) {
      merged.push(...freshGroup);
      continue;
    }
    const byIndex = new Map();
    for (const candidate of priorGroup) {
      if (candidate.merge === 'frames') byIndex.set(candidate.index ?? 0, candidate);
    }
    for (const candidate of freshGroup) {
      if (candidate.merge === 'frames') byIndex.set(candidate.index ?? 0, candidate);
    }
    merged.push(...[...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([index, candidate]) => ({ ...candidate, index })));
  }
  for (const [key, group] of groups) {
    if (!handled.has(key)) merged.push(...group);
  }
  return merged;
}

/**
 * Merge a fresh `files` emitter index over a previous one: entries are keyed by
 * their file path, so previously written files stay described. Provenance is
 * unioned; other index fields come from fresh.
 */
export function mergeIndex(previous, fresh) {
  if (!previous) return fresh;
  if (!isPlainObject(previous) || !isPlainObject(fresh)) {
    throw new Error('mergeIndex: previous and fresh indexes must be plain objects');
  }
  if (!Array.isArray(fresh.files)) throw new Error('mergeIndex: fresh index needs a "files" array');
  const priorFiles = Array.isArray(previous.files) ? previous.files : [];
  const freshPaths = new Set(fresh.files.map((entry) => entry?.file));
  return {
    ...previous,
    ...fresh,
    provenance: { ...(previous.provenance ?? {}), ...(fresh.provenance ?? {}) },
    files: [...fresh.files, ...priorFiles.filter((entry) => !freshPaths.has(entry?.file))],
  };
}

/**
 * Validate an aggregate immediately before publication: a plain object, a
 * plain `provenance` table when present, an entry for every job whose records
 * it carries (`expectedProvenance`), and exactly JSON-safe throughout. Returns
 * `value` so the emitter can validate and serialize in one expression.
 */
export function validateForPublish(value, options = {}) {
  const { expectedProvenance = [], label = 'artifact' } = options;
  if (!isPlainObject(value)) throw new Error(`${label}: aggregate must be a plain object`);
  if ('provenance' in value && !isPlainObject(value.provenance)) {
    throw new Error(`${label}: "provenance" must be a plain object`);
  }
  for (const id of expectedProvenance) {
    if (!isPlainObject(value.provenance?.[id])) {
      throw new Error(`${label}: provenance is missing a record for successful job "${id}"`);
    }
  }
  assertJsonSafe(value, label);
  return value;
}
