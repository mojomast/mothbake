import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.mjs';
import { jobsRequiringApi, normalizeOnly, runConfig, selectJobs } from '../src/runner.mjs';
import { ROOT } from './helpers.mjs';

const config = {
  jobs: [
    { id: 'a', engine: 'e' },
    { id: 'b', engine: 'e', enabled: false },
    { id: 'c', engine: 'e', recorded: { result: {} } },
    { id: 'd', engine: 'e' },
  ],
};

test('normalizeOnly accepts repeats and comma-separated values', () => {
  assert.equal(normalizeOnly(null), null);
  assert.equal(normalizeOnly([]), null);
  assert.deepEqual([...normalizeOnly(['a', 'b,c'])], ['a', 'b', 'c']);
});

test('selectJobs filters and validates ids', () => {
  assert.equal(selectJobs(config).length, 4);
  assert.deepEqual(
    selectJobs(config, ['c', 'a']).map((job) => job.id),
    ['a', 'c'],
  );
  assert.throws(() => selectJobs(config, ['nope']), /--only did not match any job: nope \(known ids: a, b, c, d\)/);
});

test('jobsRequiringApi skips disabled and recorded jobs unless forced', () => {
  assert.deepEqual(
    jobsRequiringApi(config).map((job) => job.id),
    ['a', 'd'],
  );
  assert.deepEqual(
    jobsRequiringApi(config, { force: true }).map((job) => job.id),
    ['a', 'c', 'd'],
  );
  assert.deepEqual(
    jobsRequiringApi(config, { only: ['c'] }).map((job) => job.id),
    [],
  );
});

test('runConfig --dry reports the planned actions and writes nothing', async (t) => {
  const loaded = await loadConfig({ file: path.join(ROOT, 'examples', 'manifest.json') });
  const outDir = path.join(ROOT, 'test', 'tmp', `dry-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const result = await runConfig({
    config: loaded.config,
    configDir: loaded.dir,
    outDir,
    dry: true,
    log: () => {},
  });
  assert.equal(result.dry, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.records.length, 0);
  assert.equal(result.plan.length, 9);
  assert.ok(result.plan.every((entry) => entry.action === 'recorded'));
  assert.equal(result.plan[0].baker, 'texture-tile');
  assert.ok(!fs.existsSync(outDir), 'dry runs write nothing');
});

test('runConfig strict rethrows the first job failure instead of collecting it', async (t) => {
  const dir = path.join(ROOT, 'test', 'tmp', `strict-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const live = { jobs: [{ id: 'needs-key', engine: 'e' }] };

  const collected = await runConfig({ config: live, configDir: dir, outDir: path.join(dir, 'out'), key: null, log: () => {} });
  assert.equal(collected.failures.length, 1);

  await assert.rejects(
    () => runConfig({ config: live, configDir: dir, outDir: path.join(dir, 'out'), key: null, strict: true, log: () => {} }),
    /MOTH_API_KEY is required to run live job "needs-key"/,
  );
});

test('runConfig records jobIds back into JSON configs only when they change', async (t) => {
  const dir = path.join(ROOT, 'test', 'tmp', `writeback-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, 'mothbake.json');
  const base = {
    jobs: [{ id: 'a', engine: 'e' }],
  };
  fs.writeFileSync(configFile, `${JSON.stringify(base, null, 2)}\n`);
  const outDir = path.join(dir, 'out');
  // No API calls happen: the job fails on the missing key, so nothing is
  // written back and the file stays byte-identical.
  await runConfig({
    config: JSON.parse(fs.readFileSync(configFile, 'utf8')),
    configFile,
    configDir: dir,
    outDir,
    key: null,
    writeBack: true,
    log: () => {},
  });
  assert.equal(fs.readFileSync(configFile, 'utf8'), `${JSON.stringify(base, null, 2)}\n`);
});
