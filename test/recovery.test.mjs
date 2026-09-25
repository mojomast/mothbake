import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { buildExecutionPlan } from '../src/execution-plan.mjs';
import { readRunJournal } from '../src/run-journal.mjs';
import { openRunJournal } from '../src/run-journal.mjs';
import { runConfig } from '../src/runner.mjs';
import { makeTmpDir } from './helpers.mjs';

const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

function approved(config, outDir, extra = {}) {
  const base = 'https://fake.moth.invalid';
  const plan = buildExecutionPlan({ config, outDir, configDir: outDir, baseUrl: base, force: extra.force, journalSnapshot: readRunJournal(outDir) });
  return { config, outDir, configDir: outDir, base, key: 'fixture-key', approveSpend: plan.fingerprint, env: { MOTH_MIN_INTERVAL_MS: '0', MOTH_MAX_RETRIES: '0' }, sleepImpl: async () => {}, log: () => {}, ...extra };
}

test('returned job id is durable before polling and survives emitter failure; archive resumes offline', async (t) => {
  const outDir = makeTmpDir(t, 'recovery-emitter');
  let submits = 0;
  const failingConfig = {
    jobs: [{ id: 'field', engine: 'blur-core-v1', credits: 1, bake: { type: 'raw-grid', name: 'field' } }],
    emitters: [() => { throw new Error('fixture emitter failed'); }],
  };
  const fetchImpl = async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/process')) { submits += 1; return json(202, { job_id: 'job-durable' }); }
    if (pathname.endsWith('/status')) {
      const snapshot = readRunJournal(outDir);
      assert.equal(snapshot.jobs.field.jobId, 'job-durable');
      assert.equal(snapshot.jobs.field.state, 'polling');
      return json(200, { status: 'completed' });
    }
    if (pathname.endsWith('/result')) return json(200, { result: { output: [[1, 2], [3, 4]] } });
    throw new Error(`unexpected ${init.method ?? 'GET'} ${pathname}`);
  };
  await assert.rejects(() => runConfig(approved(failingConfig, outDir, { fetchImpl })), /fixture emitter failed/);
  const failed = readRunJournal(outDir).jobs.field;
  assert.equal(failed.jobId, 'job-durable');
  assert.equal(failed.state, 'local-failed');
  assert.equal(submits, 1);

  const offline = { ...failingConfig, emitters: [{ type: 'files' }] };
  const rebuilt = await runConfig({ config: offline, outDir, configDir: outDir, base: 'https://fake.moth.invalid', key: null, log: () => {}, fetchImpl: async () => { throw new Error('offline rebuild used network'); } });
  assert.deepEqual(rebuilt.failures, []);
  assert.equal(rebuilt.plan[0].action, 'archive-rebuild');
  assert.equal(submits, 1);
  assert.equal(readRunJournal(outDir).jobs.field.state, 'published');
});

test('accepted-but-response-lost becomes unknown and never automatically resubmits', async (t) => {
  const outDir = makeTmpDir(t, 'recovery-ambiguous');
  const config = { jobs: [{ id: 'paid', engine: 'blur-v1', credits: 2 }] };
  let submits = 0;
  const first = await runConfig(approved(config, outDir, {
    fetchImpl: async (url) => {
      if (new URL(url).pathname.endsWith('/process')) { submits += 1; throw new TypeError('socket closed'); }
      throw new Error('unexpected request');
    },
  }));
  assert.equal(first.failures.length, 1);
  assert.match(first.failures[0].message, /may or may not have been created/);
  assert.equal(readRunJournal(outDir).jobs.paid.state, 'unknown-submission');
  assert.equal(submits, 1);

  const second = await runConfig({ config, outDir, configDir: outDir, key: 'fixture-key', base: 'https://fake.moth.invalid', fetchImpl: async () => { submits += 1; throw new Error('must not request'); }, log: () => {} });
  assert.equal(second.failures.length, 1);
  assert.match(second.failures[0].message, /unknown submission outcome/);
  assert.equal(second.plan[0].action, 'blocked-unknown-submission');
  assert.equal(submits, 1);
});

test('polling failure retains the submitted job id for a later resume', async (t) => {
  const outDir = makeTmpDir(t, 'recovery-poll');
  const config = { jobs: [{ id: 'paid', engine: 'blur-v1', credits: 1 }] };
  let submits = 0;
  const result = await runConfig(approved(config, outDir, {
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith('/process')) { submits += 1; return json(202, { job_id: 'job-poll' }); }
      if (pathname.endsWith('/status')) throw new TypeError('offline');
      throw new Error('unexpected request');
    },
  }));
  assert.equal(result.failures.length, 1);
  assert.equal(submits, 1);
  const journal = readRunJournal(outDir).jobs.paid;
  assert.equal(journal.jobId, 'job-poll');
  assert.equal(journal.state, 'local-failed');
  const plan = buildExecutionPlan({ config, outDir, configDir: outDir, baseUrl: 'https://fake.moth.invalid', journalSnapshot: readRunJournal(outDir) });
  assert.equal(plan.jobs[0].action, 'resume');
  assert.equal(plan.spending.submissions, 0);
});

test('crash in persisted submitting state cannot repeat POST, even with force approval', async (t) => {
  const outDir = makeTmpDir(t, 'recovery-submitting');
  const config = { jobs: [{ id: 'paid', engine: 'blur-v1', credits: 2 }] };
  const base = 'https://fake.moth.invalid';
  const initial = buildExecutionPlan({ config, outDir, configDir: outDir, baseUrl: base });
  const writer = openRunJournal(outDir);
  writer.transition('paid', 'submitting', { metadata: { recipeFingerprint: initial.jobs[0].recipeFingerprint } });
  writer.close();
  const resumed = buildExecutionPlan({ config, outDir, configDir: outDir, baseUrl: base, journalSnapshot: readRunJournal(outDir), force: true });
  assert.equal(resumed.jobs[0].action, 'blocked-unknown-submission');
  assert.equal(resumed.spending.submissions, 0);
  let requests = 0;
  const result = await runConfig({ config, outDir, configDir: outDir, base, key: 'fixture-key', force: true, fetchImpl: async () => { requests++; throw new Error('unexpected request'); } });
  assert.equal(result.plan[0].action, 'blocked-unknown-submission');
  assert.equal(result.failures.length, 1);
  assert.equal(requests, 0);
});

test('input changed after locked plan invalidates approval before asset registration', async (t) => {
  const outDir = makeTmpDir(t, 'execution-input-race');
  fs.writeFileSync(path.join(outDir, 'input.bin'), 'approved');
  let calls = 0;
  const config = { generators: { changing: () => {
    if (++calls === 4) fs.writeFileSync(path.join(outDir, 'input.bin'), 'mutated');
    return [[1]];
  } }, jobs: [{ id: 'paid', engine: 'blur-v1', credits: 1, inputs: { data: 'input.bin' }, generateValues: { type: 'changing' } }] };
  let requests = 0;
  const result = await runConfig(approved(config, outDir, { fetchImpl: async () => { requests++; throw new Error('network must not be used'); } }));
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].message, /approved plan invalidated: input bytes changed/);
  assert.equal(requests, 0);
});
