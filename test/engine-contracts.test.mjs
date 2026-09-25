import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createContractSnapshot, loadContractSnapshot, sanitizeEngineContract, validateJobsAgainstContracts, writeContractSnapshot } from '../src/engine-contracts.mjs';
import { makeTmpDir } from './helpers.mjs';

const engine = {
  engine_id: 'image-v1', name: 'Image', version: '1.2.3', credits_per_run: 2, enabled: true,
  params_schema: { type: 'object', additionalProperties: false, required: ['strength'], properties: { strength: { type: 'number', minimum: 0, maximum: 1 }, style: { enum: ['x', 'y'] } } },
  input_files: [{ name: 'image', required: true, mime_types: ['image/png'], description: '' }],
  output_files: [{ name: 'result', required: true, content_types: ['image/png'], description: '' }],
  run_policy: { timeout: 10, max_retries: 0, heartbeat: 1 }, error_codes: [],
  queue: 'secret-internal', sidecar_endpoint: 'internal',
};

test('sanitizes, dates and round-trips contract snapshots', (t) => {
  const clean = sanitizeEngineContract(engine);
  assert.equal(clean.queue, undefined);
  assert.equal(clean.engineId, 'image-v1');
  const snapshot = createContractSnapshot([engine], { apiVersion: 'v0.41.0', retrievedAt: '2026-09-25T00:00:00.000Z' });
  const file = path.join(makeTmpDir(t, 'contracts'), 'contracts.json');
  writeContractSnapshot(file, snapshot);
  assert.deepEqual(loadContractSnapshot(file), snapshot);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('secret-internal'));
});

test('validates params, versions, slots, MIME types and costs before paid work', () => {
  const snapshot = createContractSnapshot([engine]);
  const valid = validateJobsAgainstContracts({ jobs: [{ id: 'ok', engine: 'image-v1', engineVersion: '1.2.3', credits: 2, params: { strength: 0.5, style: 'x' }, inputs: { image: 'source.png' } }] }, snapshot);
  assert.deepEqual(valid, { errors: [], warnings: [] });
  const invalid = validateJobsAgainstContracts({ jobs: [{ id: 'bad', engine: 'image-v1', engineVersion: 'old', credits: 1, params: { strength: 2, typo: true }, inputs: { image: 'source.jpg', other: 'x.bin' } }] }, snapshot);
  assert.ok(invalid.errors.some((issue) => issue.path.endsWith('engineVersion')));
  assert.ok(invalid.errors.some((issue) => issue.path.endsWith('strength')));
  assert.ok(invalid.errors.some((issue) => issue.path.endsWith('typo')));
  assert.ok(invalid.errors.some((issue) => issue.path.endsWith('image') && issue.message.includes('content type')));
  assert.ok(invalid.errors.some((issue) => issue.path.endsWith('other')));
  assert.ok(invalid.warnings.some((issue) => issue.path.endsWith('credits')));
});

test('oneOf requires exactly one branch and composition keeps sibling constraints', () => {
  const snapshot = createContractSnapshot([{
    engine_id: 'composed', name: 'Composed', credits_per_run: 1, enabled: true,
    params_schema: {
      type: 'object', additionalProperties: false, required: ['value'],
      properties: {
        value: {
          type: 'number', maximum: 10,
          oneOf: [{ type: 'number', minimum: 0 }, { type: 'number', maximum: 5 }],
        },
      },
    }, input_files: [], output_files: [], run_policy: null, error_codes: [],
  }]);
  const both = validateJobsAgainstContracts({ jobs: [{ id: 'x', engine: 'composed', params: { value: 3 } }] }, snapshot);
  assert.ok(both.errors.some((issue) => /exactly one/.test(issue.message)));
  const sibling = validateJobsAgainstContracts({ jobs: [{ id: 'x', engine: 'composed', params: { value: 12 } }] }, snapshot);
  assert.ok(sibling.errors.some((issue) => /<= 10/.test(issue.message)), 'maximum sibling must still run after oneOf');
});
