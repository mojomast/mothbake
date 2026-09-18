// One full submit -> poll -> download -> bake -> emit cycle against a local
// mock of the Atlas API. No external network: the server binds to 127.0.0.1
// on an ephemeral port and serves the recorded fixtures.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { runConfig } from '../src/runner.mjs';
import { fixture, makeTmpDir, readFixture, writeJson } from './helpers.mjs';

function startMockApi(t, options = {}) {
  const state = {
    requests: [],
    submits: [],
    polls: {},
    uploaded: null,
    assetCreates: 0,
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      state.requests.push({ method: req.method, path: url.pathname, authorization: req.headers.authorization });
      const json = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      const jobMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/(status|result)$/);

      if (req.method === 'GET' && url.pathname === '/api/v1/engines') {
        return json(200, {
          engines: [
            {
              engine_id: 'blur-v1',
              name: 'Blur',
              input_type: 'image/png',
              output_type: 'image/png',
              credits_per_run: 1,
            },
          ],
        });
      }
      if (req.method === 'POST' && /^\/api\/v1\/engines\/[^/]+\/process$/.test(url.pathname)) {
        const parsed = JSON.parse(body.toString());
        state.submits.push({ ...parsed, engine: url.pathname.split('/')[4] });
        return json(200, { job_id: `job-${state.submits.length}` });
      }
      if (jobMatch && jobMatch[2] === 'status') {
        const id = jobMatch[1];
        if (options.statuses && options.statuses[id]) return json(200, options.statuses[id]);
        if (options.statusErrors && options.statusErrors[id]) {
          const failure = options.statusErrors[id];
          return json(failure.http ?? 500, { detail: failure.detail ?? 'status unavailable' });
        }
        const submission = state.submits[Number(id.split('-')[1]) - 1];
        if (submission?.params?.fail === true) {
          return json(200, { status: 'failed', error: { message: 'engine exploded' } });
        }
        state.polls[id] = (state.polls[id] || 0) + 1;
        const done = state.polls[id] > 1;
        return json(200, { status: done ? 'completed' : 'running', progress: { step: done ? 'done' : 'encoding' } });
      }
      if (jobMatch && jobMatch[2] === 'result') {
        const id = jobMatch[1];
        const submission = state.submits[Number(id.split('-')[1]) - 1];
        if (submission?.params?.mockOutputs) {
          const outputs = submission.params.mockOutputs.map((entry) => ({
            slot: entry.slot,
            url: `http://127.0.0.1:${server.address().port}${entry.path}`,
            content_type: entry.content_type,
            ...(entry.output_asset_id ? { output_asset_id: entry.output_asset_id } : {}),
          }));
          return json(200, { outputs, result: submission.params.mockResult ?? null });
        }
        if (id === 'job-1') {
          return json(200, {
            outputs: [{ slot: 'result', url: `http://127.0.0.1:${server.address().port}/files/tile.png`, content_type: 'image/png' }],
            result: null,
          });
        }
        return json(200, {
          outputs: [],
          result: { output: [[0, 0.5], [1, 0.25]] },
        });
      }
      if (req.method === 'GET' && url.pathname === '/files/tile.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(readFixture('tile.png'));
      }
      if (req.method === 'GET' && url.pathname === '/files/state.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ trained: true }));
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/assets') {
        state.assetCreates += 1;
        return json(200, {
          asset_id: 'asset-1',
          upload: { url: `http://127.0.0.1:${server.address().port}/upload/asset-1`, method: 'PUT', headers: { 'x-mock': '1' } },
        });
      }
      if (req.method === 'PUT' && url.pathname === '/upload/asset-1') {
        state.uploaded = body;
        res.writeHead(200);
        return res.end('ok');
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/assets/asset-1/complete') {
        return json(200, { ok: true });
      }
      return json(404, { detail: `no route ${req.method} ${url.pathname}` });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      t.after(() => new Promise((done) => server.close(done)));
      resolve({ base: `http://127.0.0.1:${port}`, state });
    });
  });
}

const baseConfig = (dir) => ({
  version: 1,
  generator: 'mothbake-test',
  jobs: [
    {
      id: 'tile',
      engine: 'blur-v1',
      credits: 1,
      inputs: { image: 'sources/tile.png' },
      params: { strength: 0.4, style: 'ry' },
      raw: 'tile',
      bake: { type: 'texture-tile', name: 'rock', size: 8 },
    },
    {
      id: 'grid',
      engine: 'blur-core-v1',
      credits: 1,
      generateValues: { type: 'height', size: 4, seed: 3 },
      params: { style: 'xy' },
      raw: 'grid',
      bake: { type: 'normal-map', name: 'rock', size: 8, strength: 1.5 },
    },
  ],
  emitters: [
    { type: 'files' },
    { type: 'json', file: 'bundle.json' },
    { type: 'esm', file: 'baked.mjs', export: 'ASSETS' },
  ],
});

test('a full online cycle submits, polls, downloads, bakes and emits', async (t) => {
  const dir = makeTmpDir(t, 'mock-run');
  fs.mkdirSync(path.join(dir, 'sources'), { recursive: true });
  fs.copyFileSync(fixture('tile.png'), path.join(dir, 'sources', 'tile.png'));
  const configFile = writeJson(path.join(dir, 'mothbake.json'), baseConfig(dir));
  const outDir = path.join(dir, 'out');
  const { base, state } = await startMockApi(t);

  const result = await runConfig({
    config: JSON.parse(fs.readFileSync(configFile, 'utf8')),
    configFile,
    configDir: dir,
    outDir,
    key: 'test-key',
    base,
    sleepImpl: async () => {},
    log: () => {},
  });

  assert.deepEqual(result.failures, []);
  assert.equal(result.records.length, 2);
  assert.deepEqual(result.buckets, { textures: 1, normals: 1 });

  // Submission payloads: inputs uploaded as asset ids, generated grids inlined.
  assert.equal(state.submits.length, 2);
  assert.deepEqual(state.submits[0].input_files, { image: 'asset-1' });
  assert.equal(state.submits[0].params.strength, 0.4);
  assert.equal(state.submits[1].input_files, undefined);
  assert.ok(Array.isArray(state.submits[1].params.values));
  assert.equal(state.submits[1].params.values.length, 4);
  assert.deepEqual(state.uploaded, readFixture('tile.png'));

  // Every API request carries the bearer token.
  for (const request of state.requests.filter((entry) => entry.path.startsWith('/api/v1'))) {
    assert.equal(request.authorization, 'Bearer test-key');
  }
  assert.ok(state.polls['job-1'] >= 2 && state.polls['job-2'] >= 2, 'jobs are polled until completed');

  // Raw outputs are archived under out/raw/<job>/.
  assert.deepEqual(fs.readFileSync(path.join(outDir, 'raw', 'tile', 'result.png')), readFixture('tile.png'));
  const rawResult = JSON.parse(fs.readFileSync(path.join(outDir, 'raw', 'grid', 'result.json'), 'utf8'));
  assert.deepEqual(rawResult, { output: [[0, 0.5], [1, 0.25]] });

  // Emitters wrote decoded PNGs plus the JSON and ESM bundles.
  assert.ok(fs.existsSync(path.join(outDir, 'textures', 'rock.png')));
  assert.ok(fs.existsSync(path.join(outDir, 'normals', 'rock.png')));
  assert.ok(fs.existsSync(path.join(outDir, 'bundle.json')));
  const baked = await import(`${pathToFileURL(path.join(outDir, 'baked.mjs')).href}?t=${Date.now()}`);
  assert.equal(baked.ASSETS.textures.rock.width, 8);
  assert.equal(baked.ASSETS.provenance.tile.jobId, 'job-1');

  // Job ids are written back so a rerun reuses them.
  const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.deepEqual(
    saved.jobs.map((job) => job.jobId),
    ['job-1', 'job-2'],
  );

  // Rerun: both jobs are reused, no new submissions.
  const reloaded = await loadConfig({ file: configFile });
  const second = await runConfig({
    config: reloaded.config,
    configFile,
    configDir: dir,
    outDir,
    key: 'test-key',
    base,
    sleepImpl: async () => {},
    log: () => {},
  });
  assert.deepEqual(second.failures, []);
  assert.equal(state.submits.length, 2, 'recorded job ids are reused');
  assert.equal(second.records.length, 2);
});

test('--force submits fresh jobs and a failing job is reported without stopping the run', async (t) => {
  const dir = makeTmpDir(t, 'mock-force');
  fs.mkdirSync(path.join(dir, 'sources'), { recursive: true });
  fs.copyFileSync(fixture('tile.png'), path.join(dir, 'sources', 'tile.png'));
  const config = baseConfig(dir);
  config.jobs.push({ id: 'boom', engine: 'blur-v1', params: { fail: true }, raw: 'boom', bake: { type: 'texture-tile', name: 'boom', size: 4 } });
  const configFile = writeJson(path.join(dir, 'mothbake.json'), config);
  const outDir = path.join(dir, 'out');
  const { base, state } = await startMockApi(t);

  const forced = await runConfig({
    config: JSON.parse(fs.readFileSync(configFile, 'utf8')),
    configFile,
    configDir: dir,
    outDir,
    key: 'test-key',
    base,
    force: true,
    sleepImpl: async () => {},
    log: () => {},
  });
  assert.equal(state.submits.length, 3, 'all three jobs submitted');
  assert.equal(forced.failures.length, 1);
  assert.equal(forced.failures[0].id, 'boom');
  assert.match(forced.failures[0].message, /job job-3 failed: engine exploded/);
  assert.equal(forced.records.length, 2, 'the healthy jobs still baked');
});

test('missing inputs and a missing key fail per job with actionable messages', async (t) => {
  const dir = makeTmpDir(t, 'mock-errors');
  const config = {
    jobs: [
      { id: 'ghost', engine: 'blur-v1', bake: { type: 'texture-tile' }, recorded: { outputs: { result: 'missing.png' } } },
      { id: 'no-key', engine: 'blur-v1', bake: { type: 'texture-tile' } },
      { id: 'no-input', engine: 'blur-v1', inputs: { image: 'sources/nope.png' }, bake: { type: 'texture-tile' } },
    ],
  };
  const result = await runConfig({
    config,
    configDir: dir,
    outDir: path.join(dir, 'out'),
    key: 'test-key',
    base: 'http://127.0.0.1:9',
    sleepImpl: async () => {},
    log: () => {},
  });
  assert.equal(result.failures.length, 3);
  assert.match(result.failures[0].message, /recorded output "result" not found/);
  const missingKey = await runConfig({
    config: { jobs: [{ id: 'no-key', engine: 'blur-v1', bake: { type: 'texture-tile' } }] },
    configDir: dir,
    outDir: path.join(dir, 'out2'),
    key: null,
    base: 'http://127.0.0.1:9',
    sleepImpl: async () => {},
    log: () => {},
  });
  assert.equal(missingKey.failures.length, 1);
  assert.match(missingKey.failures[0].message, /MOTH_API_KEY is required to run live job "no-key"/);
});

test('inputFrom reuses output asset ids and falls back to re-upload', async (t) => {
  const dir = makeTmpDir(t, 'mock-chain');
  const configFile = writeJson(path.join(dir, 'mothbake.json'), {
    version: 1,
    jobs: [
      {
        id: 'train',
        engine: 'qrc-train-v2',
        credits: 1,
        params: {
          mockOutputs: [
            { slot: 'model', path: '/files/state.json', content_type: 'application/json', output_asset_id: 'asset-state-1' },
            { slot: 'state', path: '/files/state.json', content_type: 'application/json' },
          ],
        },
        raw: 'train',
        bake: { type: 'seed', name: 'train-seed' },
      },
      {
        id: 'gen',
        engine: 'qrc-gen-v2',
        credits: 1,
        inputFrom: { model: { job: 'train', slot: 'model' } },
        params: { mockOutputs: [{ slot: 'result', path: '/files/tile.png', content_type: 'image/png' }] },
        raw: 'gen',
        bake: { type: 'texture-tile', name: 'gen', size: 4 },
      },
      {
        id: 'gen2',
        engine: 'qrc-gen-v2',
        credits: 1,
        inputFrom: { model: { job: 'train', slot: 'state' } },
        params: { mockOutputs: [{ slot: 'result', path: '/files/tile.png', content_type: 'image/png' }] },
        raw: 'gen2',
        bake: { type: 'texture-tile', name: 'gen2', size: 4 },
      },
    ],
  });
  const outDir = path.join(dir, 'out');
  const { base, state } = await startMockApi(t);

  const result = await runConfig({
    config: JSON.parse(fs.readFileSync(configFile, 'utf8')),
    configFile,
    configDir: dir,
    outDir,
    key: 'test-key',
    base,
    sleepImpl: async () => {},
    log: () => {},
  });

  assert.deepEqual(result.failures, []);
  assert.equal(result.records.length, 3);
  // The first consumer sends the captured asset id; the second has no asset id
  // for `state`, so it re-uploads the archived raw output.
  assert.deepEqual(state.submits[1].input_files, { model: 'asset-state-1' });
  assert.deepEqual(state.submits[2].input_files, { model: 'asset-1' });
  assert.equal(state.assetCreates, 1, 'only the fallback path creates a new asset');
  assert.deepEqual(result.provenance.train.outputs, { model: 'asset-state-1' });

  // Asset ids persist into the JSON config so a later run skips the re-upload.
  const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.deepEqual(saved.jobs[0].assetIds, { model: 'asset-state-1' });
});

// A recorded jobId must only be reused when the API confirms `completed`.
// Anything else refuses to submit a fresh job: an automatic resubmission would
// spend credits when the user only meant to re-download or re-run offline.
test('a recorded job that is completed is still reused without a new submission', async (t) => {
  const dir = makeTmpDir(t, 'mock-reuse-completed');
  const config = { jobs: [{ id: 'reuse', engine: 'blur-core-v1', jobId: 'job-old', raw: 'reuse', bake: { type: 'normal-map', name: 'reused', size: 8 } }] };
  const { base, state } = await startMockApi(t, { statuses: { 'job-old': { status: 'completed' } } });

  const result = await runConfig({ config, configDir: dir, outDir: path.join(dir, 'out'), key: 'test-key', base, sleepImpl: async () => {}, log: () => {} });

  assert.deepEqual(result.failures, []);
  assert.equal(result.records.length, 1);
  assert.equal(state.submits.length, 0, 'a completed job is reused, never resubmitted');
  assert.equal(result.provenance.reuse.jobId, 'job-old');
});

test('a recorded failed job is not auto-resubmitted and demands --force', async (t) => {
  const dir = makeTmpDir(t, 'mock-reuse-failed');
  const config = { jobs: [{ id: 'retry', engine: 'blur-v1', jobId: 'job-old', raw: 'retry', bake: { type: 'texture-tile', name: 'retry', size: 8 } }] };
  const { base, state } = await startMockApi(t, { statuses: { 'job-old': { status: 'failed', error: { message: 'engine exploded' } } } });

  const result = await runConfig({ config, configDir: dir, outDir: path.join(dir, 'out'), key: 'test-key', base, sleepImpl: async () => {}, log: () => {} });

  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].message, /recorded job "retry" \(job-old\) is failed, not completed/);
  assert.match(result.failures[0].message, /--force/);
  assert.equal(state.submits.length, 0, 'a failed recorded job must not be auto-resubmitted');
});

test('a recorded job with an unknown status is not auto-resubmitted', async (t) => {
  const dir = makeTmpDir(t, 'mock-reuse-unknown');
  const config = { jobs: [{ id: 'maybe', engine: 'blur-v1', jobId: 'job-old', raw: 'maybe', bake: { type: 'texture-tile', name: 'maybe', size: 8 } }] };
  const { base, state } = await startMockApi(t, { statuses: { 'job-old': { progress: { step: 'queued' } } } });

  const result = await runConfig({ config, configDir: dir, outDir: path.join(dir, 'out'), key: 'test-key', base, sleepImpl: async () => {}, log: () => {} });

  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].message, /recorded job "maybe" \(job-old\) is unknown, not completed/);
  assert.match(result.failures[0].message, /--force/);
  assert.equal(state.submits.length, 0, 'an unknown-status recorded job must not be auto-resubmitted');
});

test('a recorded job whose status cannot be verified is not auto-resubmitted', async (t) => {
  const dir = makeTmpDir(t, 'mock-reuse-error');
  const config = { jobs: [{ id: 'unverified', engine: 'blur-v1', jobId: 'job-old', raw: 'unverified', bake: { type: 'texture-tile', name: 'unverified', size: 8 } }] };
  const { base, state } = await startMockApi(t, { statusErrors: { 'job-old': { http: 503, detail: 'service unavailable' } } });

  const result = await runConfig({ config, configDir: dir, outDir: path.join(dir, 'out'), key: 'test-key', base, sleepImpl: async () => {}, log: () => {} });

  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].message, /recorded job "unverified" \(job-old\) could not be verified/);
  assert.match(result.failures[0].message, /--force/);
  assert.equal(state.submits.length, 0, 'an unverifiable recorded job must not be auto-resubmitted');
});

test('--force resubmits a recorded failed job', async (t) => {
  const dir = makeTmpDir(t, 'mock-reuse-force');
  fs.mkdirSync(path.join(dir, 'sources'), { recursive: true });
  fs.copyFileSync(fixture('tile.png'), path.join(dir, 'sources', 'tile.png'));
  const config = {
    jobs: [{
      id: 'retry',
      engine: 'blur-v1',
      jobId: 'job-old',
      inputs: { image: 'sources/tile.png' },
      raw: 'retry',
      bake: { type: 'texture-tile', name: 'retry', size: 8 },
    }],
  };
  const { base, state } = await startMockApi(t, { statuses: { 'job-old': { status: 'failed', error: { message: 'engine exploded' } } } });

  const result = await runConfig({ config, configDir: dir, outDir: path.join(dir, 'out'), key: 'test-key', base, force: true, sleepImpl: async () => {}, log: () => {} });

  assert.deepEqual(result.failures, []);
  assert.equal(state.submits.length, 1, '--force submits a fresh job');
  assert.equal(result.records.length, 1);
});
