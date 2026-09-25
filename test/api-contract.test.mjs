import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createApi } from '../src/api.mjs';
import { makeTmpDir } from './helpers.mjs';

const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json', ...headers },
});
const apiWith = (fetchImpl, options = {}) => createApi({
  baseUrl: 'https://api.test', key: 'private-key', env: {}, minIntervalMs: 0,
  maxRetries: 0, fetchImpl, ...options,
});
const abortError = () => new DOMException('cancelled by caller', 'AbortError');

// A real fetch rejects when its signal is aborted; keep that behavior in mocks
// so timeout and caller-cancellation tests also cover propagation to fetch.
function untilAbort(init) {
  assert.ok(init.signal instanceof AbortSignal);
  return new Promise((resolve, reject) => {
    if (init.signal.aborted) return reject(init.signal.reason);
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });
}

test('API request timeout aborts the in-flight fetch without retrying', async () => {
  let calls = 0;
  const api = apiWith((_url, init) => { calls++; return untilAbort(init); }, {
    requestTimeoutMs: 15, maxRetries: 2, retryBaseMs: 1,
  });
  await assert.rejects(api.request('/api/v1/jobs'), /timed out|timeout|abort|deadline/i);
  assert.equal(calls, 1, 'a timed-out request is not silently repeated');
});

test('caller abort propagates through API request and signed download', async () => {
  for (const operation of [
    (api, signal) => api.request('/api/v1/jobs', { signal }),
    (api, signal) => api.downloadOutput('https://storage.test/file?signature=secret', { signal }),
  ]) {
    const controller = new AbortController();
    let calls = 0;
    const api = apiWith((_url, init) => { calls++; return untilAbort(init); }, { maxRetries: 2 });
    const pending = operation(api, controller.signal);
    setTimeout(() => controller.abort(abortError()), 5);
    await assert.rejects(pending, /abort|cancel/i);
    assert.equal(calls, 1);
  }
});

test('caller abort after dispatch of submit or asset POST is ambiguous without remote cancellation', async (t) => {
  const dir = makeTmpDir(t, 'asset-post-abort');
  const file = path.join(dir, 'tile.png');
  fs.writeFileSync(file, Buffer.from('tile'));
  for (const stage of ['submit', 'create', 'complete']) {
    const controller = new AbortController();
    const calls = [];
    let started;
    const requestStarted = new Promise((resolve) => { started = resolve; });
    const api = apiWith((url, init) => {
      calls.push({ url, init });
      if (stage === 'complete' && url.endsWith('/assets')) {
        return json({ asset_id: 'asset-1', upload: { url: 'https://storage.test/put', method: 'PUT' } });
      }
      if (url === 'https://storage.test/put') return new Response(null, { status: 200 });
      assert.equal(init.method, 'POST');
      started();
      return untilAbort(init);
    }, { maxRetries: 2 });
    const pending = stage === 'submit'
      ? api.request('/api/v1/engines/engine-1/process', {
        method: 'POST', body: { params: {} }, submit: true, signal: controller.signal,
      })
      : api.uploadAsset(file, { signal: controller.signal });
    await requestStarted;
    controller.abort(abortError());
    await assert.rejects(pending, (error) => {
      assert.equal(error.ambiguous, true, 'a dispatched POST could have changed remote state');
      assert.match(error.message, /may or may not|ambiguous|check/i);
      return true;
    });
    assert.equal(calls.filter(({ init }) => init.method === 'POST').length, stage === 'complete' ? 2 : 1);
    assert.ok(calls.every(({ url }) => !/cancel|stop|terminate/i.test(url)));
  }
});

test('upload size and symlink checks happen before asset registration', async (t) => {
  const dir = makeTmpDir(t, 'asset-local-limits');
  const file = path.join(dir, 'large.bin');
  fs.writeFileSync(file, Buffer.from('12345'));
  let calls = 0;
  const api = apiWith(async () => { calls += 1; return json({}); }, { maxUploadBytes: 4 });
  await assert.rejects(api.uploadAsset(file), /no larger than 4 bytes/);
  const link = path.join(dir, 'linked.bin');
  fs.symlinkSync(file, link);
  await assert.rejects(api.uploadAsset(link), /ELOOP|symbolic link/i);
  assert.equal(calls, 0);
});

test('upload and download have independent fetch timeouts', async (t) => {
  const dir = makeTmpDir(t, 'api-timeout');
  const file = path.join(dir, 'tile.png');
  fs.writeFileSync(file, Buffer.from('tile'));
  let puts = 0;
  const uploadApi = apiWith((url, init) => {
    if (url === 'https://api.test/api/v1/assets') {
      return json({ asset_id: 'asset-1', upload: { url: 'https://storage.test/put?signature=secret', method: 'PUT' } });
    }
    assert.equal(url, 'https://storage.test/put?signature=secret');
    assert.equal(init.method, 'PUT');
    assert.equal(init.headers?.Authorization, undefined);
    puts++;
    return untilAbort(init);
  }, { requestTimeoutMs: 1000, uploadTimeoutMs: 15 });
  await assert.rejects(uploadApi.uploadAsset(file), /timeout|abort|upload|request failed/i);
  assert.equal(puts, 1);

  let gets = 0;
  const downloadApi = apiWith((url, init) => {
    assert.equal(url, 'https://storage.test/file?signature=secret');
    gets++;
    return untilAbort(init);
  }, { downloadTimeoutMs: 15 });
  await assert.rejects(downloadApi.downloadOutput('https://storage.test/file?signature=secret'), (error) => {
    assert.doesNotMatch(String(error), /secret|signature|storage\.test/);
    return true;
  });
  assert.equal(gets, 1);
});

test('polling abort is local and does not send a remote cancellation', async () => {
  const controller = new AbortController();
  const calls = [];
  let firstPoll;
  const polled = new Promise((resolve) => { firstPoll = resolve; });
  const api = apiWith((url, init) => {
    calls.push({ url, method: init.method });
    firstPoll();
    return json({ status: 'running', progress: { step: 'rendering' } });
  }, { pollIntervalMs: 100 });
  const pending = api.waitForJob('job-1', { signal: controller.signal });
  await polled;
  controller.abort(abortError());
  await assert.rejects(pending, /abort|cancel/i);
  assert.deepEqual(calls.map(({ url }) => new URL(url).pathname), ['/api/v1/jobs/job-1/status']);
  assert.ok(calls.every(({ method }) => method === 'GET'));
});

test('asset and job reads use authenticated API GETs with encoded identifiers', async () => {
  const paths = [];
  const api = apiWith((url, init) => {
    paths.push(new URL(url).pathname);
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.Authorization, 'Bearer private-key');
    assert.equal(init.redirect, 'manual');
    return json({ items: [] });
  });
  await api.listJobs();
  await api.getJob('job/1');
  await api.listAssets();
  await api.getAsset('asset/1');
  await api.getAssetDownload('asset/1');
  await api.getStorageUsage();
  assert.deepEqual(paths, [
    '/api/v1/jobs', '/api/v1/jobs/job%2F1', '/api/v1/assets',
    '/api/v1/assets/asset%2F1', '/api/v1/assets/asset%2F1/download', '/api/v1/me/storage',
  ]);
});

test('API redirects are rejected without fetching their cross-origin Location', async () => {
  const calls = [];
  const api = apiWith((url, init) => {
    calls.push({ url, init });
    return new Response(null, { status: 302, headers: { location: 'https://storage.test/steal?signature=secret' } });
  });
  await assert.rejects(api.getAssetDownload('asset-1'), (error) => {
    assert.doesNotMatch(JSON.stringify(error), /storage\.test|signature|secret|private-key/);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer private-key');
});

test('signed download redirects never acquire API credentials', async () => {
  const calls = [];
  const api = apiWith((url, init) => {
    calls.push({ url, init });
    if (url === 'https://storage.test/start?signature=secret') {
      return new Response(null, { status: 302, headers: { location: 'https://cdn.test/end?signature=another-secret' } });
    }
    return new Response(Buffer.from('ok'));
  });
  assert.deepEqual(await api.downloadOutput('https://storage.test/start?signature=secret'), Buffer.from('ok'));
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ init }) => init?.headers?.Authorization === undefined));
});

test('API errors redact signed URLs and credentials even in structured body', async () => {
  const signed = 'https://storage.test/file?signature=secret-token';
  const api = apiWith(async () => json({
    detail: 'invalid request', nested: { url: signed, token: 'private-key' },
    errors: [{ message: `bearer private-key ${signed}` }],
  }, 400));
  await assert.rejects(api.getAsset('asset-1'), (error) => {
    assert.equal(error.status, 400);
    assert.doesNotMatch(JSON.stringify(error), /storage\.test|signature|secret-token|private-key/);
    return true;
  });
});

test('retry diagnostics and exposed error body never include signed query strings', async () => {
  const signed = 'https://storage.test/file?signature=secret-token';
  const logs = [];
  let calls = 0;
  const api = apiWith(async () => {
    calls++;
    return json({ detail: signed, nested: { download_url: signed, authorization: 'Bearer private-key' } }, 503);
  }, { maxRetries: 1, retryBaseMs: 1, sleepImpl: async () => {}, log: (line) => logs.push(String(line)) });
  await assert.rejects(api.getAsset('asset-1'), (error) => {
    assert.doesNotMatch(JSON.stringify(error), /secret-token|signature|storage\.test|private-key/);
    return true;
  });
  assert.equal(calls, 2);
  assert.doesNotMatch(logs.join('\n'), /secret-token|signature|storage\.test|private-key/);
});

test('refreshing an output asset obtains a fresh URL and downloads with no API bearer', async () => {
  const calls = [];
  const signed = 'https://storage.test/fresh?signature=secret';
  const api = apiWith((url, init) => {
    calls.push({ url, init });
    if (url === 'https://api.test/api/v1/assets/asset-1/download') {
      assert.equal(init.headers.Authorization, 'Bearer private-key');
      assert.equal(init.redirect, 'manual');
      return json({ download_url: signed });
    }
    assert.equal(url, signed);
    assert.equal(init?.headers?.Authorization, undefined);
    return new Response(Buffer.from('png'), { headers: { 'content-type': 'image/png' } });
  });
  assert.deepEqual(await api.refreshOutputAsset('asset-1', { contentType: 'image/png' }), Buffer.from('png'));
  assert.equal(calls.length, 2);
});

test('a fresh output-asset URL is never used for submit, including when download fails', async () => {
  const signed = 'https://storage.test/fresh?signature=secret';
  const calls = [];
  const api = apiWith((url, init) => {
    calls.push({ url, init });
    if (url.startsWith('https://api.test/')) return json({ download_url: signed });
    return new Response('unavailable', { status: 503 });
  });
  await assert.rejects(api.refreshOutputAsset('asset-1'), /download|503/i);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.method, 'GET');
  assert.ok(calls.every(({ init }) => init?.method !== 'POST'));
  assert.equal(calls[1].init?.headers?.Authorization, undefined);
});

test('refreshed output-asset downloads enforce declared type and byte limits', async () => {
  const signed = 'https://storage.test/fresh?signature=secret';
  const api = apiWith((url) => url.startsWith('https://api.test/')
    ? json({ download_url: signed })
    : new Response(Buffer.from('12345'), { headers: { 'content-type': 'image/png', 'content-length': '1' } }),
  { maxDownloadBytes: 4 });
  await assert.rejects(api.refreshOutputAsset('asset-1', { contentType: 'image/png' }), (error) => {
    assert.match(error.message, /4 byte limit/);
    assert.doesNotMatch(JSON.stringify(error), /secret|signature|storage\.test/);
    return true;
  });
});
