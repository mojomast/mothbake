// Pacing, retry and adaptive-poll behavior, all offline and in virtual time.
//
// `createApi`'s `sleepImpl`/`nowImpl`/`randomImpl` hooks turn wall-clock waits
// into recorded virtual time, so every backoff, Retry-After and poll interval
// is asserted exactly without slowing the suite down. The end-to-end case uses
// an injected fake fetch that injects 429s; no socket or live API is required.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createApi } from '../src/api.mjs';
import { runConfig } from '../src/runner.mjs';
import { makeTmpDir, readFixture, writeJson } from './helpers.mjs';

const jsonResponse = (status, value, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
  text: async () => (value === undefined ? '' : JSON.stringify(value)),
});

/**
 * A scripted client: one queued response (or a function that throws) per
 * request, with sleeps recorded against a virtual clock.
 */
function harness(responses, options = {}) {
  const sleeps = [];
  const logs = [];
  const calls = [];
  let now = 0;
  const queue = [...responses];
  const api = createApi({
    baseUrl: 'https://api.test',
    key: 'test-key',
    env: {},
    fetchImpl: async (url, init = {}) => {
      calls.push(`${init.method || 'GET'} ${url}`);
      if (!queue.length) throw new Error(`unexpected ${init.method || 'GET'} ${url}`);
      const next = queue.shift();
      if (typeof next === 'function') return next(url, init);
      return next;
    },
    sleepImpl: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    nowImpl: () => now,
    randomImpl: () => 1,
    log: (message) => logs.push(String(message)),
    ...options,
  });
  return { api, sleeps, logs, calls };
}

test('all API requests share one gate: serialized, with a minimum spacing', async () => {
  const events = [];
  const sleeps = [];
  let now = 0;
  let sequence = 0;
  const api = createApi({
    baseUrl: 'https://api.test',
    key: 'test-key',
    env: {},
    fetchImpl: async () => {
      const id = ++sequence;
      events.push(`start:${id}`);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => {
          events.push(`end:${id}`);
          return '{"engines":[]}';
        },
      };
    },
    sleepImpl: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    nowImpl: () => now,
    minIntervalMs: 300,
  });

  await Promise.all([api.listEngines(), api.listEngines(), api.listEngines()]);
  assert.deepEqual(events, ['start:1', 'end:1', 'start:2', 'end:2', 'start:3', 'end:3'], 'one request in flight at a time');
  assert.deepEqual(sleeps, [300, 300], 'starts are spaced by the minimum interval');
});

test('MOTH_MIN_INTERVAL_MS overrides the request spacing', async () => {
  const { api, sleeps } = harness([jsonResponse(200, {}), jsonResponse(200, {})], { env: { MOTH_MIN_INTERVAL_MS: '500' } });
  await api.listEngines();
  await api.getEngine('blur-v1');
  assert.deepEqual(sleeps, [500]);
});

test('a 429 waits for Retry-After and then succeeds', async () => {
  const { api, sleeps, logs, calls } = harness([
    jsonResponse(429, { detail: 'slow down' }, { 'retry-after': '2' }),
    jsonResponse(200, { engines: [{ engine_id: 'blur-v1' }] }),
  ]);
  const engines = await api.listEngines();
  assert.deepEqual(engines, [{ engine_id: 'blur-v1' }]);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [2000]);
  assert.match(logs.join('\n'), /rate limited, retrying in 2s \(attempt 1\/5\)/);
});

test('Retry-After also accepts an HTTP date and is capped', async () => {
  const dated = harness([
    jsonResponse(429, {}, { 'retry-after': new Date(5000).toUTCString() }),
    jsonResponse(200, {}),
  ]);
  await dated.api.listEngines();
  assert.deepEqual(dated.sleeps, [5000], 'virtual clock starts at 0, so the date is 5s away');

  const capped = harness(
    [jsonResponse(429, {}, { 'retry-after': '9999' }), jsonResponse(200, {})],
    { retryAfterCapMs: 5000 },
  );
  await capped.api.listEngines();
  assert.deepEqual(capped.sleeps, [5000], 'an absurd Retry-After cannot stall a run for hours');
});

test('a 429 without Retry-After backs off exponentially with jitter', async () => {
  const { api, sleeps } = harness([
    jsonResponse(429, {}),
    jsonResponse(429, {}),
    jsonResponse(429, {}),
    jsonResponse(200, {}),
  ]);
  await api.listEngines();
  assert.deepEqual(sleeps, [1000, 2000, 4000], 'random=1 yields the ceiling of each equal-jitter wait');

  const floor = harness(
    [jsonResponse(429, {}), jsonResponse(429, {}), jsonResponse(200, {})],
    { randomImpl: () => 0 },
  );
  await floor.api.listEngines();
  assert.deepEqual(floor.sleeps, [500, 1000], 'random=0 yields the floor of each equal-jitter wait');
});

test('the backoff is capped and the retry budget is bounded', async () => {
  const { api, sleeps, calls } = harness(
    Array.from({ length: 9 }, () => jsonResponse(429, { detail: 'slow down' })),
    { maxRetries: 8, retryCapMs: 3000 },
  );
  await assert.rejects(api.listEngines(), /429.*rate limited; gave up after 8 retries/s);
  assert.equal(calls.length, 9, 'one initial attempt plus eight retries');
  assert.deepEqual(sleeps, [1000, 2000, 3000, 3000, 3000, 3000, 3000, 3000]);
  assert.equal(Math.max(...sleeps), 3000);
});

test('polling backs off while the progress marker is unchanged and resets on a transition', async () => {
  const running = (step) => jsonResponse(200, { status: 'running', progress: { step } });
  const { api, sleeps, calls } = harness([
    running('a'),
    running('a'),
    running('b'),
    jsonResponse(200, { status: 'completed', progress: { step: 'b' } }),
  ]);
  await api.waitForJob('job-1');
  assert.equal(calls.length, 4);
  assert.deepEqual(sleeps, [1500, 2250, 1500], 'grow 1.5x while stalled, reset on the step change');
});

test('polling keeps backing off up to the ceiling', async () => {
  const running = jsonResponse(200, { status: 'running', progress: { step: 'a' } });
  const { api, sleeps } = harness([
    running, running, running, running, running,
    jsonResponse(200, { status: 'completed' }),
  ]);
  await api.waitForJob('job-1');
  assert.deepEqual(sleeps, [1500, 2250, 3375, 5000, 5000]);
  assert.equal(Math.max(...sleeps), 5000);
});

test('adaptive polling still honours the timeout', async () => {
  const running = jsonResponse(200, { status: 'running', progress: { step: 'a' } });
  const { api, sleeps, calls } = harness([running, running, running, running, running, running]);
  await assert.rejects(api.waitForJob('job-1', { timeoutMs: 4000 }), /timed out after 4s/);
  assert.equal(calls.length, 4);
  assert.deepEqual(sleeps, [1500, 2250, 3375]);
});

test('GETs retry transient 5xx responses', async () => {
  const { api, sleeps, calls } = harness([
    jsonResponse(500, { detail: 'boom' }),
    jsonResponse(503, { detail: 'unavailable' }, { 'retry-after': '2' }),
    jsonResponse(200, { status: 'running' }),
  ]);
  const status = await api.jobStatus('job-1');
  assert.equal(status.status, 'running');
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [1000, 2000]);
});

test('GETs retry transport failures, but not programming errors', async () => {
  const transient = harness([
    async () => {
      throw new TypeError('fetch failed');
    },
    jsonResponse(200, { status: 'completed' }),
  ]);
  assert.equal((await transient.api.jobStatus('job-1')).status, 'completed');
  assert.equal(transient.calls.length, 2);
  assert.deepEqual(transient.sleeps, [1000]);

  const bug = harness([
    async () => {
      throw new Error('bug');
    },
  ]);
  await assert.rejects(bug.api.jobStatus('job-1'), /bug/);
  assert.equal(bug.calls.length, 1);
  assert.deepEqual(bug.sleeps, []);
});

test('a submit is retried only on 429 and otherwise fails closed', async () => {
  // 429 already rejected the request, so no job can exist: safe to retry.
  const limited = harness([
    jsonResponse(429, { detail: 'slow down' }, { 'retry-after': '1' }),
    jsonResponse(429, { detail: 'slow down' }, { 'retry-after': '1' }),
    jsonResponse(200, { job_id: 'job-1' }),
  ]);
  assert.deepEqual(await limited.api.submitJob('blur-v1', { params: {} }), { job_id: 'job-1' });
  assert.equal(limited.calls.length, 3);
  assert.deepEqual(limited.sleeps, [1000, 1000]);

  // A definite client rejection is a plain error.
  const rejected = harness([jsonResponse(402, { detail: 'insufficient credits' })]);
  await assert.rejects(rejected.api.submitJob('blur-v1', { params: {} }), /402: insufficient credits/);
  assert.equal(rejected.calls.length, 1);

  // 5xx: the job may already exist — never retried.
  const serverError = harness([jsonResponse(500, { detail: 'engine exploded' })]);
  await assert.rejects(serverError.api.submitJob('blur-v1', { params: {} }), (error) => {
    assert.match(error.message, /may or may not have been created/);
    assert.match(error.message, /credit history/);
    assert.equal(error.status, 500);
    return true;
  });
  assert.equal(serverError.calls.length, 1);
  assert.deepEqual(serverError.sleeps, []);

  // Transport failure: same rule.
  const offline = harness([
    async () => {
      throw new TypeError('fetch failed');
    },
  ]);
  await assert.rejects(offline.api.submitJob('blur-v1', { params: {} }), /may or may not have been created/);
  assert.equal(offline.calls.length, 1);
  assert.deepEqual(offline.sleeps, []);

  // Even a 503 with Retry-After is a 5xx for a submit.
  const unavailable = harness([jsonResponse(503, { detail: 'unavailable' }, { 'retry-after': '1' })]);
  await assert.rejects(unavailable.api.submitJob('blur-v1', { params: {} }), /may or may not have been created/);
  assert.equal(unavailable.calls.length, 1);
  assert.deepEqual(unavailable.sleeps, []);
});

test('safe asset and job GETs retry transient failures', async () => {
  const { api, calls, sleeps } = harness([
    jsonResponse(503, { detail: 'unavailable' }),
    jsonResponse(200, { items: [] }),
    async () => { throw new TypeError('fetch failed'); },
    jsonResponse(200, { asset_id: 'asset-1' }),
  ], { minIntervalMs: 0 });
  await api.listJobs();
  await api.getAsset('asset-1');
  assert.equal(calls.length, 4);
  assert.deepEqual(sleeps, [1000, 1000]);
  assert.ok(calls.every((call) => call.startsWith('GET ')));
});

test('asset create and complete never repeat after ambiguous 5xx or transport failures', async (t) => {
  const dir = makeTmpDir(t, 'asset-retry');
  const file = path.join(dir, 'tile.png');
  fs.writeFileSync(file, Buffer.from('tile'));
  for (const stage of ['create', 'complete']) {
    for (const failure of ['server', 'network']) {
      const calls = [];
      const api = createApi({
        baseUrl: 'https://api.test', key: 'test-key', env: {}, minIntervalMs: 0,
        maxRetries: 3, retryBaseMs: 1,
        fetchImpl: async (url, init) => {
          calls.push(`${init.method} ${url}`);
          if (url === 'https://api.test/api/v1/assets' && stage === 'complete') {
            return jsonResponse(200, { asset_id: 'asset-1', upload: { url: 'https://storage.test/put', method: 'PUT' } });
          }
          if (url === 'https://storage.test/put') return { ok: true, status: 200 };
          if (failure === 'network') throw new TypeError('fetch failed');
          return jsonResponse(503, { detail: 'unavailable' }, { 'retry-after': '0' });
        },
      });
      await assert.rejects(api.uploadAsset(file), (error) => {
        assert.match(error.message, /may or may not|ambiguous|check/i);
        assert.equal(error.ambiguous, true);
        if (failure === 'server') assert.equal(error.status, 503);
        return true;
      }, `${stage}: ${failure}`);
      const postCalls = calls.filter((call) => call.startsWith('POST '));
      assert.equal(postCalls.length, stage === 'create' ? 1 : 2, `${stage}: ${failure}: no duplicate POST`);
      assert.equal(calls.length, stage === 'create' ? 1 : 3);
    }
  }
});

/** An Atlas-shaped fake fetch that rejects the first `limits.*` calls with 429. */
function rateLimitedFetch(limits = {}) {
  const state = { created: 0, submits: 0, statuses: 0, requests: [] };
  const submitLimit = limits.submit ?? 2;
  const statusLimit = limits.status ?? 1;
  const fetchImpl = async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    const method = init.method || 'GET';
    state.requests.push(`${method} ${pathname}`);
    if (method === 'POST' && pathname === '/api/v1/engines/blur-v1/process') {
      state.submits += 1;
      if (state.submits <= submitLimit) return jsonResponse(429, { detail: 'slow down' }, { 'retry-after': '1' });
      state.created += 1;
      return jsonResponse(200, { job_id: 'job-1' });
    }
    if (method === 'GET' && pathname === '/api/v1/jobs/job-1/status') {
      state.statuses += 1;
      if (state.statuses <= statusLimit) return jsonResponse(429, { detail: 'slow down' });
      if (state.statuses <= statusLimit + 2) return jsonResponse(200, { status: 'running', progress: { step: 'encoding' } });
      return jsonResponse(200, { status: 'completed', progress: { step: 'done' } });
    }
    if (method === 'GET' && pathname === '/api/v1/jobs/job-1/result') {
      return jsonResponse(200, {
        outputs: [{ slot: 'result', url: 'https://storage.test/files/tile.png', content_type: 'image/png' }],
        result: null,
      });
    }
    if (method === 'GET' && pathname === '/files/tile.png') {
      const bytes = readFixture('tile.png');
      return { ok: true, status: 200, headers: { get: (name) => name === 'content-type' ? 'image/png' : null },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    }
    return jsonResponse(404, { detail: `no route ${method} ${pathname}` });
  };
  return { base: 'https://api.test', state, fetchImpl };
}

test('a rate-limited run retries, submits exactly once, and completes', async (t) => {
  const dir = makeTmpDir(t, 'rate-limit-run');
  const outDir = path.join(dir, 'out');
  const configFile = writeJson(path.join(dir, 'mothbake.json'), {
    version: 1,
    generator: 'mothbake-test',
    jobs: [
      {
        id: 'tile',
        engine: 'blur-v1',
        credits: 1,
        params: { strength: 0.4 },
        raw: 'tile',
        bake: { type: 'texture-tile', name: 'rock', size: 8 },
      },
    ],
    emitters: [{ type: 'files' }],
  });
  const { base, state, fetchImpl } = rateLimitedFetch();

  const sleeps = [];
  const logs = [];
  let now = 0;
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const preview = await runConfig({ config, configFile, configDir: dir, outDir, key: 'test-key', base, env: {}, dry: true });
  const result = await runConfig({
    config,
    configFile,
    configDir: dir,
    outDir,
    key: 'test-key',
    base,
    fetchImpl,
    env: {},
    approveSpend: preview.executionPlan.fingerprint,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    nowImpl: () => now,
    randomImpl: () => 1,
    log: (message) => logs.push(String(message)),
  });

  assert.deepEqual(result.failures, []);
  assert.equal(result.records.length, 1);
  assert.equal(state.created, 1, 'exactly one job was created across all retries');
  assert.equal(state.submits, 3, 'two 429s were retried into one accepted submit');
  assert.equal(state.statuses, 4, 'one 429 poll, two running polls, one completed poll');
  // Virtual time: two Retry-After waits, one gate spacing before the first
  // poll, one status backoff, the adaptive poll intervals, and the gate spacing
  // before the result request.
  assert.deepEqual(sleeps, [1000, 1000, 300, 1000, 1500, 2250, 300]);
  assert.ok(logs.some((message) => /rate limited, retrying in 1s \(attempt 1\/5\)/.test(message)));
  assert.ok(logs.some((message) => /rate limited, retrying in 1s \(attempt 2\/5\)/.test(message)));
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).jobs[0].jobId, 'job-1', 'the paid id was persisted');
  assert.ok(fs.existsSync(path.join(outDir, 'textures', 'rock.png')));
  assert.deepEqual(fs.readFileSync(path.join(outDir, 'raw', 'tile', 'result.png')), readFixture('tile.png'));
});
