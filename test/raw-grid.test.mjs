import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bakers } from '../src/bakers/index.mjs';
import { runConfig } from '../src/runner.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

test('raw-grid bakes the typed and direct output unchanged (no probability normalization)', () => {
  for (const result of [{ output: [[0, 8], [1, 2]], provenance: { backend: 'unknown' } }, [[0, 8], [1, 2]]]) {
    const record = bakers['raw-grid']({ id: 'field' }, { result, bake: { name: 'field' } });
    assert.deepEqual(record, { bucket: 'grids', key: 'field', value: { width: 2, height: 2, values: [[0, 8], [1, 2]] } });
    assert.equal(record.value.values.flat().reduce((a, b) => a + b, 0), 11);
  }
});

test('raw-grid rejects ragged, non-finite and non-grid payloads', () => {
  for (const result of [{ output: [[1], [2, 3]] }, { output: [[Infinity]] }, { output: { trajectory: [] } }]) {
    assert.throws(() => bakers['raw-grid']({ id: 'field' }, { result, bake: {} }), /raw-grid:/);
  }
});

test('recorded raw-grid emits exact numbers and retains original result separately', async (t) => {
  const outDir = path.join(ROOT, 'test', 'tmp', `raw-grid-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const result = await runConfig({
    config: {
      jobs: [{ id: 'field', engine: 'blur-core-v1', recorded: { result: { output: [[0, 8], [1, 2]], provenance: { backend: 'unknown' } } }, bake: { type: 'raw-grid' } }],
      emitter: { type: 'json', file: 'baked.json' },
    }, outDir, log: () => {},
  });
  assert.deepEqual(result.failures, []);
  const baked = JSON.parse(fs.readFileSync(path.join(outDir, 'baked.json'), 'utf8'));
  assert.deepEqual(baked.grids.field.values, [[0, 8], [1, 2]]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outDir, 'raw/field/result.json'), 'utf8')).provenance, { backend: 'unknown' });
});
