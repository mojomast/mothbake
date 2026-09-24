import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApi, DEFAULT_MAX_API_RESPONSE_BYTES, DEFAULT_MAX_DOWNLOAD_BYTES } from '../src/api.mjs';

const headers = (values = {}) => ({ get: (name) => values[name] ?? null });
const streamed = (bytes, values = {}, status = 200) => {
  let reads = 0;
  const response = {
    ok: status >= 200 && status < 300,
    status,
    headers: headers(values),
    body: new ReadableStream({
      pull(controller) {
        reads++;
        controller.enqueue(bytes);
        controller.close();
      },
    }, { highWaterMark: 0 }),
    text: () => { throw new Error('unbounded text() called'); },
    arrayBuffer: () => { throw new Error('unbounded arrayBuffer() called'); },
  };
  return { response, reads: () => reads };
};
const client = (fetchImpl, options = {}) => createApi({
  baseUrl: 'https://api.test', key: 'private-key', env: {}, minIntervalMs: 0, maxRetries: 0, fetchImpl, ...options,
});

test('safe defaults and invalid limits', () => {
  const api = client(async () => {});
  assert.equal(api.maxApiResponseBytes, DEFAULT_MAX_API_RESPONSE_BYTES);
  assert.equal(api.maxDownloadBytes, DEFAULT_MAX_DOWNLOAD_BYTES);
  for (const value of [-1, Infinity, 1.5, '5']) {
    assert.throws(() => client(async () => {}, { maxApiResponseBytes: value }), /safe integer/);
  }
});

test('API reads exact limit and rejects oversized streamed bodies with and without length', async () => {
  const exact = streamed(Buffer.from('{"a":1}'), { 'content-length': '7' });
  assert.deepEqual(await client(async () => exact.response, { maxApiResponseBytes: 7 }).request('/ok'), { a: 1 });
  for (const values of [{}, { 'content-length': '1' }]) {
    const over = streamed(Buffer.from('{"a":12}'), values);
    await assert.rejects(client(async () => over.response, { maxApiResponseBytes: 7 }).request('/over'), /API response exceeds 7 byte limit/);
  }
  const header = streamed(Buffer.from('x'), { 'content-length': '8' });
  await assert.rejects(client(async () => header.response, { maxApiResponseBytes: 7 }).request('/header'), /API response exceeds 7 byte limit/);
  assert.equal(header.reads(), 0, 'rejects declared oversized body before reading');
});

test('downloads enforce exact limit, absent/deceptive lengths, content-type and empty checks', async () => {
  const signed = 'https://storage.test/output?signature=top-secret';
  const bytes = Buffer.from('1234');
  const exact = streamed(bytes, { 'content-type': 'image/png', 'content-length': '4' });
  assert.deepEqual(await client(async (_url, init) => {
    assert.equal(init, undefined, 'download has no bearer or request options');
    return exact.response;
  }, { maxDownloadBytes: 4 }).downloadOutput(signed, { contentType: 'image/png' }), bytes);
  for (const values of [{}, { 'content-length': '1' }]) {
    const over = streamed(Buffer.from('12345'), values);
    await assert.rejects(client(async () => over.response, { maxDownloadBytes: 4 }).downloadOutput(signed), (error) => {
      assert.match(error.message, /download exceeds 4 byte limit/);
      assert.doesNotMatch(error.message, /top-secret|signature|storage\.test/);
      return true;
    });
  }
  const tooLong = streamed(bytes, { 'content-length': '5' });
  await assert.rejects(client(async () => tooLong.response, { maxDownloadBytes: 4 }).downloadOutput(signed), /byte limit/);
  assert.equal(tooLong.reads(), 0);
  await assert.rejects(client(async () => streamed(bytes, { 'content-type': 'text/plain' }).response).downloadOutput(signed, { contentType: 'image/png' }), /content-type/);
  await assert.rejects(client(async () => streamed(Buffer.alloc(0)).response).downloadOutput(signed), /empty body/);
  await assert.rejects(client(async () => streamed(bytes, {}, 403).response).downloadOutput(signed), /download -> 403/);
  await assert.rejects(client(async () => { throw new Error(signed); }).downloadOutput(signed), /download: request failed/);
});

test('download stream failures do not expose presigned URL or credentials', async () => {
  const signed = 'https://storage.test/output?signature=top-secret';
  const response = {
    ok: true,
    status: 200,
    headers: headers(),
    body: new ReadableStream({
      pull(controller) {
        controller.error(new Error(`stream failed at ${signed} with bearer private-key`));
      },
    }, { highWaterMark: 0 }),
  };
  await assert.rejects(client(async () => response).downloadOutput(signed), (error) => {
    assert.equal(error.message, 'download: body read failed');
    assert.doesNotMatch(String(error), /top-secret|private-key|storage\.test|signature/);
    return true;
  });
  await assert.rejects(client(async () => ({ ok: true, status: 200, headers: headers(), arrayBuffer: async () => {
    throw new Error(signed);
  } })).downloadOutput(signed), /download: body read failed/);
});

test('downloads cancel unread bodies for HTTP and content-type rejection', async () => {
  for (const { status, contentType, declared, expected } of [
    { status: 403, contentType: 'image/png', expected: /download -> 403/ },
    { status: 200, contentType: 'text/plain', declared: 'image/png', expected: /content-type/ },
  ]) {
    let reads = 0;
    let cancellations = 0;
    const response = {
      ok: status === 200,
      status,
      headers: headers({ 'content-type': contentType }),
      body: new ReadableStream({
        pull(controller) {
          reads++;
          controller.enqueue(Buffer.from('unwanted'));
        },
        cancel() { cancellations++; },
      }, { highWaterMark: 0 }),
    };
    await assert.rejects(client(async () => response).downloadOutput('https://storage.test/file', { contentType: declared }), expected);
    assert.equal(reads, 0, 'body was not read');
    assert.equal(cancellations, 1, 'unread body was canceled');
  }
});

test('errors omit untrusted URL and credentials; diagnostics are bounded', async () => {
  const secret = 'https://storage.test/file?signature=private-value';
  const response = streamed(Buffer.from(JSON.stringify({ detail: secret, extra: 'x'.repeat(1000) })), {}, 400);
  await assert.rejects(client(async () => response.response).request('/bad'), (error) => {
    assert.match(error.message, /GET \/bad -> 400/);
    assert.doesNotMatch(error.message, /private-value|storage\.test|private-key/);
    return true;
  });
  const long = streamed(Buffer.from(JSON.stringify({ detail: 'a'.repeat(1000) })), {}, 400);
  await assert.rejects(client(async () => long.response).request('/bad'), (error) => {
    assert.ok(error.message.length < 240);
    return true;
  });
  const raw = streamed(Buffer.from(secret), {}, 400);
  await assert.rejects(client(async () => raw.response).request('/bad'), (error) => {
    assert.doesNotMatch(error.message, /private-value/);
    return true;
  });
});

test('mock fallback supports text/arrayBuffer without body and still checks size', async () => {
  const mock = (text) => ({ ok: true, status: 200, headers: headers(), text: async () => text });
  assert.deepEqual(await client(async () => mock('{}'), { maxApiResponseBytes: 2 }).request('/ok'), {});
  await assert.rejects(client(async () => mock('{ }'), { maxApiResponseBytes: 2 }).request('/large'), /byte limit/);
  const binary = (value) => ({ ok: true, status: 200, headers: headers(), arrayBuffer: async () => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) });
  assert.deepEqual(await client(async () => binary(Buffer.from('a')), { maxDownloadBytes: 1 }).downloadOutput('https://storage.test'), Buffer.from('a'));
  await assert.rejects(client(async () => binary(Buffer.from('ab')), { maxDownloadBytes: 1 }).downloadOutput('https://storage.test'), /byte limit/);
  await assert.rejects(client(async () => ({ ...mock('{}'), body: {} })).request('/bad'), /not a readable stream/);
});

test('bearer is sent to API base but not presigned download', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === 'https://api.test/api/v1/engines') return { ok: true, status: 200, text: async () => '{"engines":[]}' };
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1]).buffer };
  };
  const api = client(fetchImpl);
  await api.listEngines();
  await api.downloadOutput('https://storage.test/file?signature=secret');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer private-key');
  assert.equal(calls[1].init, undefined);
});
