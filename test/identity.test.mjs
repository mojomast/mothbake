import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  canonicalJson, hashBytes, hashFile, hashJson, recipeFingerprint,
  generationInstanceFingerprint, rawArtifactFingerprint, localBakeFingerprint, exportFingerprint,
} from '../src/identity.mjs';

test('canonical JSON is stable across key insertion order and rejects lossy values at any depth', () => {
  assert.equal(canonicalJson({ z: [{ b: 2, a: 1 }], a: true }), '{"a":true,"z":[{"a":1,"b":2}]}');
  assert.equal(hashJson({ a: 1, b: { x: 2, y: 3 } }), hashJson({ b: { y: 3, x: 2 }, a: 1 }));
  for (const value of [undefined, { a: undefined }, [undefined], { a: [NaN] }, { x: Infinity },
    { x: () => 1 }, { x: Symbol('x') }, { a: new Date() }, [, 1]]) {
    assert.throws(() => canonicalJson(value), TypeError);
  }
  const cycle = { child: {} };
  cycle.child.parent = cycle;
  assert.throws(() => hashJson(cycle), /cyclic/);
  const shared = { x: 1 };
  assert.equal(canonicalJson([shared, shared]), '[{"x":1},{"x":1}]');
  const extra = [1];
  extra.note = 'hidden';
  assert.throws(() => canonicalJson(extra), /extra array property/);
  assert.throws(() => recipeFingerprint({ engine: 'x', params: undefined }), /unsupported undefined/);
});

test('file hashes use bytes, not file names', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mothbake-id-'));
  try {
    const a = path.join(dir, 'a.bin');
    const b = path.join(dir, 'b.bin');
    writeFileSync(a, Buffer.from([0, 255, 1]));
    writeFileSync(b, Buffer.from([0, 255, 1]));
    assert.equal(hashFile(a), hashFile(b));
    writeFileSync(b, Buffer.from([0, 255, 2]));
    assert.notEqual(hashFile(a), hashFile(b));
    assert.equal(hashFile(a), hashBytes(Buffer.from([0, 255, 1])));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recipe, generation, raw, bake and export layers change independently', () => {
  const base = { engine: 'image', backend: 'gpu', mode: 'fast', version: 'v2', params: { size: 32 },
    inputHashes: { image: 'bytes-a' }, generator: { type: 'seeded', seed: 42 }, dependencies: { mask: 'upstream-a' } };
  const recipe = recipeFingerprint(base);
  assert.equal(recipe, recipeFingerprint({ ...base, params: { size: 32 }, inputHashes: { image: 'bytes-a' } }));
  for (const change of [{ backend: 'cpu' }, { mode: 'slow' }, { version: 'v3' },
    { params: { size: 64 } }, { inputHashes: { image: 'bytes-b' } },
    { generator: { type: 'seeded', seed: 43 } }, { dependencies: { mask: 'upstream-b' } }]) {
    assert.notEqual(recipe, recipeFingerprint({ ...base, ...change }));
  }
  const generation = generationInstanceFingerprint({ recipe, jobId: 'job-1' });
  assert.notEqual(generation, generationInstanceFingerprint({ recipe, jobId: 'job-2' }));
  const raw = rawArtifactFingerprint({ generation, outputs: { image: 'bytes-a' }, result: { seed: 42 } });
  assert.notEqual(raw, rawArtifactFingerprint({ generation, outputs: { image: 'bytes-b' }, result: { seed: 42 } }));
  const bake = localBakeFingerprint({ raw, bake: { type: 'atlas', size: 32 } });
  const otherBake = localBakeFingerprint({ raw, bake: { type: 'atlas', size: 64 } });
  assert.notEqual(bake, otherBake);
  const exported = exportFingerprint({ bake, emitter: { type: 'files', dir: 'assets' } });
  assert.equal(exported, exportFingerprint({ emitter: { dir: 'assets', type: 'files' }, bake }));
  assert.notEqual(exported, exportFingerprint({ bake: otherBake, emitter: { type: 'files', dir: 'assets' } }));
  assert.notEqual(exported, exportFingerprint({ bake, emitter: { type: 'files', dir: 'other' } }));
  assert.equal(new Set([recipe, generation, raw, bake, exported]).size, 5);
});
