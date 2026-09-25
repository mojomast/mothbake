// Content identities for offline planning and incremental builds.
// Integration: hashFile(path) for each input byte stream; pass those hashes to
// recipeFingerprint({ engine, backend, mode, version, params, inputHashes,
// generator, dependencies }). Then chain generationInstanceFingerprint({ recipe,
// jobId }), rawArtifactFingerprint({ generation, outputs, result }),
// localBakeFingerprint({ raw, bake }), exportFingerprint({ bake, emitter }).
// `outputs` maps output slots to byte hashes, `result` is JSON-compatible,
// `bake` and `emitter` are the corresponding configuration objects. A recipe
// describes requested work, whereas a generation instance identifies a run.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Serialize JSON data with sorted object keys; fail instead of losing data. */
export function canonicalJson(value) {
  const active = new Set();
  function encode(item, at) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError(`${at}: non-finite number`);
      return JSON.stringify(item);
    }
    if (typeof item !== 'object') throw new TypeError(`${at}: unsupported ${typeof item}`);
    if (active.has(item)) throw new TypeError(`${at}: cyclic value`);
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new TypeError(`${at}: unsupported object`);
    }
    if (Object.getOwnPropertySymbols(item).length) throw new TypeError(`${at}: symbol keys are unsupported`);
    active.add(item);
    try {
      if (Array.isArray(item)) {
        const parts = [];
        for (let i = 0; i < item.length; i++) {
          if (!Object.hasOwn(item, i)) throw new TypeError(`${at}[${i}]: sparse array`);
          const descriptor = Object.getOwnPropertyDescriptor(item, i);
          if (!Object.hasOwn(descriptor, 'value')) throw new TypeError(`${at}[${i}]: accessor is unsupported`);
          parts.push(encode(descriptor.value, `${at}[${i}]`));
        }
        for (const key of Object.keys(item)) {
          if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length) {
            throw new TypeError(`${at}.${key}: extra array property is unsupported`);
          }
        }
        return `[${parts.join(',')}]`;
      }
      const parts = [];
      for (const key of Object.keys(item).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!Object.hasOwn(descriptor, 'value')) throw new TypeError(`${at}.${key}: accessor is unsupported`);
        parts.push(`${JSON.stringify(key)}:${encode(descriptor.value, `${at}.${key}`)}`);
      }
      return `{${parts.join(',')}}`;
    } finally {
      active.delete(item);
    }
  }
  return encode(value, '$');
}

/** SHA-256 hex digest of bytes; path names do not contribute to the hash. */
export function hashBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('hashBytes requires bytes');
  return createHash('sha256').update(bytes).digest('hex');
}

export function hashFile(file) {
  return hashBytes(readFileSync(file));
}

export function hashJson(value) {
  return hashBytes(Buffer.from(canonicalJson(value)));
}

function stage(kind, payload) {
  return hashJson({ domain: `mothbake:${kind}:v1`, payload });
}

/** Requested generation recipe; omit optional values or pass JSON values. */
export function recipeFingerprint(options) {
  const { engine } = options;
  if (typeof engine !== 'string' || !engine) throw new TypeError('recipe engine must be a non-empty string');
  const fields = { backend: null, mode: null, version: null, params: {}, inputHashes: {}, generator: null, dependencies: {} };
  for (const key of Object.keys(fields)) if (Object.hasOwn(options, key)) fields[key] = options[key];
  return stage('recipe', { engine, ...fields });
}

/** Identity of recorded fixture content, independent of source filenames. */
export function recordedFixtureFingerprint({ outputs = {}, result = null }) {
  return stage('recorded-fixture', { outputs, result });
}

/** A particular generation for a recipe (e.g. an API job ID or fixture ID).
 * Supply a recordedFixtureFingerprint as fixture when a fixed fixture ID can
 * refer to changing bytes between runs.
 */
export function generationInstanceFingerprint({ recipe, jobId, fixture = null }) {
  if (typeof recipe !== 'string' || !recipe || typeof jobId !== 'string' || !jobId) throw new TypeError('generation requires recipe and jobId strings');
  if (fixture !== null && (typeof fixture !== 'string' || !fixture)) throw new TypeError('generation fixture must be a non-empty fingerprint');
  return stage('generation-instance', fixture === null ? { recipe, jobId } : { recipe, jobId, fixture });
}

/** Captured raw bytes and result for a generation. */
export function rawArtifactFingerprint(options) {
  const { generation } = options;
  if (typeof generation !== 'string' || !generation) throw new TypeError('raw artifact requires generation fingerprint');
  const outputs = Object.hasOwn(options, 'outputs') ? options.outputs : {};
  const result = Object.hasOwn(options, 'result') ? options.result : null;
  return stage('raw-artifact', { generation, outputs, result });
}

/** Content-bound upstream input identity for a downstream recipe dependency. */
export function dependencyArtifactFingerprint({ job, slot, raw, sha256 }) {
  if ([job, slot, raw, sha256].some((value) => typeof value !== 'string' || !value)) {
    throw new TypeError('dependency artifact requires job, slot, raw and sha256 strings');
  }
  return stage('dependency-artifact', { job, slot, raw, sha256 });
}

/** Local transformation of a raw artifact. */
export function localBakeFingerprint({ raw, bake }) {
  if (typeof raw !== 'string' || !raw) throw new TypeError('local bake requires raw fingerprint');
  return stage('local-bake', { raw, bake });
}

/** Publication of a baked artifact with emitter configuration. */
export function exportFingerprint({ bake, emitter }) {
  if (typeof bake !== 'string' || !bake) throw new TypeError('export requires bake fingerprint');
  return stage('export', { bake, emitter });
}
