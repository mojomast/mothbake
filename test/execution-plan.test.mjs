import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { assertSpendApproved, buildExecutionPlan } from '../src/execution-plan.mjs';
import { makeTmpDir } from './helpers.mjs';
import { createContractSnapshot, writeContractSnapshot } from '../src/engine-contracts.mjs';

test('plan hashes input bytes, expands dependencies and freezes spending', (t) => {
  const dir = makeTmpDir(t, 'execution-plan');
  fs.writeFileSync(path.join(dir, 'same-name.bin'), 'first');
  const config = { jobs: [
    { id: 'consumer', engine: 'b', inputFrom: { model: 'source/result' }, credits: 3 },
    { id: 'unrelated', engine: 'c', recorded: { result: { ok: true } } },
    { id: 'source', engine: 'a', inputs: { data: 'same-name.bin' }, credits: 2 },
  ] };
  const outDir = path.join(dir, 'out');
  const first = buildExecutionPlan({ config, configDir: dir, outDir, only: 'consumer', baseUrl: 'https://api.example' });
  assert.deepEqual(first.jobs.map((job) => job.id), ['source', 'consumer']);
  assert.deepEqual(first.spending, { submissions: 2, estimatedCredits: 5, unknownCost: 0 });
  assert.equal(first.jobs[1].dependencies.model.recipeFingerprint, first.jobs[0].recipeFingerprint);
  assert.throws(() => assertSpendApproved(first, null), new RegExp(first.fingerprint));
  assert.doesNotThrow(() => assertSpendApproved(first, first.fingerprint));

  fs.writeFileSync(path.join(dir, 'same-name.bin'), 'second');
  const second = buildExecutionPlan({ config, configDir: dir, outDir, only: 'consumer', baseUrl: 'https://api.example' });
  assert.notEqual(first.jobs[0].recipeFingerprint, second.jobs[0].recipeFingerprint);
  assert.notEqual(first.jobs[1].recipeFingerprint, second.jobs[1].recipeFingerprint, 'upstream change dirties dependent recipe');
  assert.notEqual(first.fingerprint, second.fingerprint);
});

test('plan distinguishes recorded, verified archive, resume, legacy and ambiguity', (t) => {
  const dir = makeTmpDir(t, 'execution-actions');
  const outDir = path.join(dir, 'out');
  fs.mkdirSync(path.join(outDir, 'raw', 'archived'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'raw', 'archived', 'result.json'), '{}');
  const config = { jobs: [
    { id: 'recorded', engine: 'e', recorded: { result: {} } },
    { id: 'archived', engine: 'e' },
    { id: 'resume', engine: 'e' },
    { id: 'legacy', engine: 'e', jobId: 'old' },
    { id: 'unknown', engine: 'e' },
  ] };
  const bare = buildExecutionPlan({ config, configDir: dir, outDir });
  const recipe = Object.fromEntries(bare.jobs.map((job) => [job.id, job.recipeFingerprint]));
  const journalSnapshot = { version: 1, jobs: {
    archived: { state: 'downloaded', jobId: 'ja', metadata: { recipeFingerprint: recipe.archived, rawFingerprint: 'raw' }, history: [] },
    resume: { state: 'polling', jobId: 'jr', metadata: { recipeFingerprint: recipe.resume }, history: [] },
    unknown: { state: 'unknown-submission', jobId: null, metadata: { recipeFingerprint: recipe.unknown }, history: [] },
  } };
  const plan = buildExecutionPlan({ config, configDir: dir, outDir, journalSnapshot });
  assert.deepEqual(plan.jobs.map((job) => job.action), ['recorded', 'blocked-archive-conflict', 'resume', 'legacy-reuse', 'blocked-unknown-submission']);
  assert.deepEqual(plan.spending, { submissions: 0, estimatedCredits: 0, unknownCost: 0 });
  assert.doesNotThrow(() => assertSpendApproved(plan, null));
});

test('unknown costs are explicit rather than zero', () => {
  const plan = buildExecutionPlan({ config: { budget: { allowUnknownCost: false }, jobs: [{ id: 'x', engine: 'e' }] } });
  assert.deepEqual(plan.spending, { submissions: 1, estimatedCredits: 0, unknownCost: 1 });
  assert.equal(plan.admission.allowed, false);
  assert.throws(() => assertSpendApproved(plan, plan.fingerprint), /unknown cost/);
  const accepted = buildExecutionPlan({ config: { budget: { allowUnknownCost: true, maxSubmissions: 1 }, jobs: [{ id: 'x', engine: 'e' }] } });
  assert.equal(accepted.admission.allowed, true);
  assert.throws(() => assertSpendApproved(accepted, accepted.fingerprint.slice(1)), /unknown-cost/);
});

test('local engines are blocked from Moth submissions even with force', () => {
  for (const force of [false, true]) {
    const plan = buildExecutionPlan({
      force,
      config: { jobs: [{ id: 'local-job', engine: 'local:quantumblur:abc123', jobId: 'old-job', credits: 5 }] },
    });
    assert.equal(plan.jobs[0].action, 'blocked-local-engine');
    assert.equal(plan.jobs[0].jobId, null);
    assert.match(plan.jobs[0].blockReason, /explicit local backend command.*configured backend path/);
    assert.deepEqual(plan.spending, { submissions: 0, estimatedCredits: 0, unknownCost: 0 });
  }
});

test('budget policy blocks over-limit frozen plans before approval', () => {
  const plan = buildExecutionPlan({ config: { budget: { maxEstimatedCredits: 2, maxSubmissions: 1 }, jobs: [{ id: 'a', engine: 'e', credits: 2 }, { id: 'b', engine: 'e', credits: 1 }] } });
  assert.equal(plan.admission.allowed, false);
  assert.match(plan.admission.violations.join(' '), /credits 3 exceed budget 2/);
  assert.match(plan.admission.violations.join(' '), /submissions 2 exceed budget 1/);
  assert.throws(() => assertSpendApproved(plan, plan.fingerprint), /outside the local budget/);
});

test('a changed recipe cannot overwrite an immutable raw archive or become a submit', async (t) => {
  const dir = makeTmpDir(t, 'plan-archive-conflict');
  const outDir = path.join(dir, 'out');
  const config = { jobs: [{ id: 'x', engine: 'e', params: { strength: 1 }, recorded: { result: { output: [[1]] } } }] };
  // Build a real archive through a recorded run, then remove the recorded path
  // from intent and change generation parameters.
  const { runConfig } = await import('../src/runner.mjs');
  await runConfig({ config, outDir, configDir: dir, log: () => {} });
  const changed = { jobs: [{ id: 'x', engine: 'e', params: { strength: 2 }, credits: 1 }] };
  const plan = buildExecutionPlan({ config: changed, outDir, configDir: dir });
  assert.equal(plan.jobs[0].action, 'blocked-archive-conflict');
  assert.equal(plan.spending.submissions, 0);
  assert.match(plan.jobs[0].blockReason, /different generation/);
});

test('recorded plans retain missing-input uncertainty and defer missing fixture failure to execution', () => {
  const plan = buildExecutionPlan({ config: { jobs: [{ id: 'x', engine: 'e', inputs: { image: 'not-generated.png' }, recorded: { outputs: { result: 'missing-fixture.png' } } }] } });
  assert.equal(plan.jobs[0].action, 'recorded');
  assert.deepEqual(plan.jobs[0].recorded.outputs.result, { status: 'missing', declaredPath: 'missing-fixture.png' });
});

test('dated contract snapshots supply engine version and cost when the recipe omits them', (t) => {
  const dir = makeTmpDir(t, 'plan-contract');
  const snapshot = createContractSnapshot([{
    engine_id: 'e', name: 'E', version: '1.2.3', credits_per_run: 4, enabled: true,
    params_schema: { type: 'object' }, input_files: [], output_files: [], run_policy: null, error_codes: [],
  }], { retrievedAt: '2026-09-25T00:00:00.000Z' });
  writeContractSnapshot(path.join(dir, 'contracts.json'), snapshot);
  const plan = buildExecutionPlan({ configDir: dir, config: { contractSnapshot: 'contracts.json', jobs: [{ id: 'x', engine: 'e' }] } });
  assert.equal(plan.jobs[0].estimatedCredits, 4);
  assert.equal(plan.jobs[0].costSource, 'contract-snapshot');
  assert.deepEqual(plan.spending, { submissions: 1, estimatedCredits: 4, unknownCost: 0 });
});

test('journal recipe provenance blocks legacy id after recipe change', (t) => {
  const dir = makeTmpDir(t, 'legacy-provenance');
  const config = { jobs: [{ id: 'x', engine: 'e', jobId: 'old-job', params: { seed: 1 } }] };
  const old = buildExecutionPlan({ config, outDir: dir });
  const changed = { jobs: [{ ...config.jobs[0], params: { seed: 2 } }] };
  const journalSnapshot = { version: 1, jobs: { x: { state: 'local-failed', jobId: 'old-job', metadata: { recipeFingerprint: old.jobs[0].recipeFingerprint }, history: [] } } };
  const plan = buildExecutionPlan({ config: changed, outDir: dir, journalSnapshot });
  assert.equal(plan.jobs[0].action, 'blocked-recipe-conflict');
  assert.equal(plan.spending.submissions, 0);
});

test('recorded upstream bytes bind dependent recipe and selected generation', (t) => {
  const dir = makeTmpDir(t, 'recorded-dependency');
  fs.writeFileSync(path.join(dir, 'fixture.bin'), 'one');
  const config = { jobs: [
    { id: 'up', engine: 'e', recorded: { outputs: { image: 'fixture.bin' } } },
    { id: 'down', engine: 'e', inputFrom: { image: 'up/image' }, credits: 1 },
  ] };
  const first = buildExecutionPlan({ config, configDir: dir, outDir: path.join(dir, 'out') });
  fs.writeFileSync(path.join(dir, 'fixture.bin'), 'two');
  const second = buildExecutionPlan({ config, configDir: dir, outDir: path.join(dir, 'out') });
  assert.equal(first.jobs[0].recipeFingerprint, second.jobs[0].recipeFingerprint);
  assert.notEqual(first.jobs[1].recipeFingerprint, second.jobs[1].recipeFingerprint);
  assert.notEqual(first.jobs[0].selectedIdentity.recorded.outputs.image, second.jobs[0].selectedIdentity.recorded.outputs.image);
});
