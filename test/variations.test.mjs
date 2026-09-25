import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_VARIATIONS, refineVariationRequest, resolveVariationPlan } from '../src/variations.mjs';

test('resolves exact bounded choices, constraints and stable deltas', () => {
  const request = {
    version: 1, baselineId: 'panel', baselineParams: { density: 2, wear: 0.2, style: 'clean' },
    parameters: { density: { values: [2, 4, 6] }, wear: { min: 0, max: 1, steps: 3 }, style: { values: ['clean', 'aged'] } },
    constraints: [{ left: 'wear', op: '<=', value: 0.5 }], count: 4, seed: 9,
  };
  const first = resolveVariationPlan(request);
  const second = resolveVariationPlan({ ...request, parameters: { style: request.parameters.style, wear: request.parameters.wear, density: request.parameters.density } });
  assert.deepEqual(first, second);
  assert.equal(first.searchSpace, 18);
  assert.equal(first.candidates.length, 4);
  assert.ok(first.candidates.every((candidate) => candidate.params.wear <= 0.5));
  assert.ok(first.candidates.every((candidate) => !Object.hasOwn(candidate.parameterDelta, 'density') || candidate.parameterDelta.density !== 2));
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
});

test('rejects unbounded/oversized/empty plans instead of sweeping implicitly', () => {
  const base = { version: 1, baselineId: 'x', baselineParams: { x: 0 }, parameters: { x: { min: 0, max: 1, steps: 2 } } };
  assert.throws(() => resolveVariationPlan({ ...base, parameters: {} }), /at least one/);
  assert.throws(() => resolveVariationPlan({ ...base, count: MAX_VARIATIONS + 1 }), /variation count/);
  assert.throws(() => resolveVariationPlan({ ...base, parameters: { x: { min: 0, max: 1 } } }), /needs values/);
  assert.throws(() => resolveVariationPlan({ ...base, constraints: [{ left: 'x', op: '>', value: 2 }] }), /reject every/);
  const huge = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`p${index}`, { min: 0, max: 1, steps: 10 }]));
  assert.throws(() => resolveVariationPlan({ ...base, parameters: huge }), /search space/);
});

test('refinement centers finite ranges on a selected candidate', () => {
  const selected = { id: 'panel-v03', params: { wear: 0.6, relief: 2, label: 'keep' } };
  const request = refineVariationRequest(selected, {
    wear: { radius: 0.2, steps: 3, min: 0, max: 1 },
    relief: { radius: 1, steps: 3, min: 0 },
  }, { count: 4, seed: 3 });
  const plan = resolveVariationPlan(request);
  assert.equal(plan.baselineId, selected.id);
  assert.equal(plan.candidates.length, 4);
  assert.ok(plan.candidates.every((item) => item.params.wear >= 0.4 && item.params.wear <= 0.8));
  assert.ok(plan.candidates.every((item) => item.params.label === 'keep'));
});
