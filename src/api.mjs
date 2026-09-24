// API client for the Moth Quantum Atlas service (https://api.mothquantum.com).
//
// Zero dependencies: uses the global fetch. Everything is injectable so tests
// can run against a local mock server (`fetchImpl`, `sleep`). The API key is
// passed in explicitly and never persisted.

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_BASE_URL = 'https://api.mothquantum.com';
export const DEFAULT_POLL_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_POLL_INTERVAL_MS = 1500;
export const DEFAULT_POLL_MAX_INTERVAL_MS = 5000;
export const DEFAULT_MIN_INTERVAL_MS = 300;
export const DEFAULT_MAX_RETRIES = 5;
export const DEFAULT_RETRY_BASE_MS = 1000;
export const DEFAULT_RETRY_CAP_MS = 30000;
export const DEFAULT_RETRY_AFTER_CAP_MS = 120000;
export const DEFAULT_MAX_API_RESPONSE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const MAX_ERROR_DETAIL_LENGTH = 200;

const CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.zip': 'application/zip',
  '.json': 'application/json',
  '.wav': 'audio/wav',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.bin': 'application/octet-stream',
  '.hdr': 'image/vnd.radiance',
  '.exr': 'image/x-exr',
};

export class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status ?? null;
    this.body = options.body ?? null;
  }
}

export function guessContentType(file) {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/** Read MOTH_API_KEY from an environment object, with a clear error. */
export function readKey(env = process.env) {
  const key = (env.MOTH_API_KEY || '').trim();
  if (!key) {
    throw new Error('MOTH_API_KEY is not set. Export a key from your account, or use recorded fixtures for an offline run.');
  }
  return key;
}

/**
 * Precedence: explicit CLI flag > MOTH_API_BASE environment > config > default.
 */
export function resolveBaseUrl(options = {}) {
  const { base, configBaseUrl, env = process.env } = options;
  return (base || env.MOTH_API_BASE || configBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A GET (or a non-submit POST such as an asset operation) may be retried on
// these statuses; a job submit only on 429, because anything else could already
// have created a paid job.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
// Socket-level failures worth retrying on a GET. Node's fetch reports them as
// TypeError with the real error on `cause`; other thrown errors are treated as
// bugs and surfaced immediately.
const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN',
  'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'ENOTFOUND',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_RESPONSE_STATUS_CODE',
]);

function envNumber(name, fallback, env) {
  const raw = env?.[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number (got "${raw}")`);
  return Math.floor(value);
}

/** True for transport failures worth retrying on a safe request. */
export function isTransientNetworkError(error) {
  if (!error) return false;
  const code = error.code ?? error.cause?.code;
  if (typeof code === 'string' && TRANSIENT_CODES.has(code.toUpperCase())) return true;
  return error.name === 'TypeError' || error.name === 'TimeoutError' || error.name === 'AbortError';
}

// Retry-After: seconds or an HTTP date. Capped so a misbehaving header cannot
// stall a run for hours.
function parseRetryAfterMs(headers, nowMs, capMs) {
  const raw = headers?.get?.('retry-after');
  if (raw === null || raw === undefined || raw === '') return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(capMs, Math.round(seconds * 1000));
  const dateMs = Date.parse(raw);
  return Number.isFinite(dateMs) ? Math.min(capMs, Math.max(0, dateMs - nowMs)) : null;
}

// Exponential backoff with equal jitter: the wait stays within [ceiling/2, ceiling].
function backoffMs(attempt, baseMs, capMs, randomImpl) {
  const ceiling = Math.min(capMs, baseMs * 2 ** (attempt - 1));
  return Math.max(1, Math.round(ceiling * (0.5 + 0.5 * randomImpl())));
}

const formatWait = (ms) => `${Number((ms / 1000).toFixed(2))}s`;

// A submit that failed without a confirmed response may still have created a
// paid job. Fail closed with an actionable message instead of retrying.
function submitAmbiguousError(label, reason, cause) {
  const error = new ApiError(
    `${label} did not confirm a new job${reason ? `: ${reason}` : ''}. `
    + 'The job may or may not have been created — check the job list and credit history on the platform before re-running. '
    + 'Submit requests are never retried automatically after network errors or 5xx responses, because that could pay for a second job.',
    { status: cause?.status ?? null, body: cause?.body ?? null },
  );
  error.ambiguous = true;
  return error;
}

/** Content-type without parameters, lowercased; '' for anything else. */
export function normalizeContentType(value) {
  if (typeof value !== 'string') return '';
  return value.split(';')[0].trim().toLowerCase();
}

function byteLimit(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

// Only expose short, plain-language server details. A server can include
// presigned URLs, credentials, or arbitrary output in a detail/title field.
function safeDetail(value, key) {
  if (typeof value !== 'string') return '';
  const detail = value.trim();
  if (/https?:\/\/|[?&][\w.-]+=|\b(?:bearer|authorization|secret|token|signature|password|api[_-]?key)\b/i.test(detail)
    || (key && detail.includes(key))) return '';
  return detail.slice(0, MAX_ERROR_DETAIL_LENGTH);
}

async function readLimited(response, limit, kind) {
  const length = response.headers?.get?.('content-length');
  if (length != null && /^\d+$/.test(String(length).trim()) && Number(length) > limit) {
    try { await response.body?.cancel?.(); } catch { /* Preserve the size-limit error. */ }
    throw new ApiError(`${kind} exceeds ${limit} byte limit`);
  }
  const body = response.body;
  if (body != null) {
    // Never use text()/arrayBuffer() when a body exists: those methods would
    // allocate the entire response before the limit could be checked.
    if (typeof body.getReader !== 'function') throw new TypeError(`${kind} body is not a readable stream`);
    const reader = body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new ApiError(`${kind} exceeds ${limit} byte limit`);
        chunks.push(value);
      }
      return Buffer.concat(chunks, size);
    } catch (error) {
      try { await reader.cancel(); } catch { /* Preserve the original read error. */ }
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
  // Legacy injectable fetch mocks may only provide text()/arrayBuffer().
  // Native fetch always supplies a body for non-empty responses.
  const data = kind === 'API response'
    ? Buffer.from(await response.text(), 'utf8')
    : Buffer.from(await response.arrayBuffer());
  if (data.length > limit) throw new ApiError(`${kind} exceeds ${limit} byte limit`);
  return data;
}

/**
 * Create a client bound to a base URL and (optional) key.
 *
 * Every request goes through one concurrency-1 gate spaced by at least
 * `minIntervalMs` (env `MOTH_MIN_INTERVAL_MS`, default 300 ms). Failed requests
 * retry within a bounded budget (env `MOTH_MAX_RETRIES`, default 5; backoff
 * `MOTH_RETRY_BASE_MS` default 1000, ceiling `MOTH_RETRY_CAP_MS` default 30000,
 * jittered). GETs and non-submit POSTs retry 429, transient 5xx and network
 * failures; a job submit is retried only on 429, because anything else could
 * already have created a paid job.
 *
 * `nowImpl`/`randomImpl` exist so tests can run in virtual time with a
 * deterministic jitter; production callers never pass them.
 * `maxApiResponseBytes` (default 8 MiB) and `maxDownloadBytes` (default
 * 256 MiB) cap response bodies, including when Content-Length is absent or
 * incorrect. Limits are inclusive and accept non-negative safe integers.
 *
 * @param {{
 *   baseUrl?: string, key?: string, env?: object,
 *   fetchImpl?: typeof fetch, sleepImpl?: (ms: number) => Promise<void>,
 *   nowImpl?: () => number, randomImpl?: () => number,
 *   log?: Function, minIntervalMs?: number, maxRetries?: number,
 *   retryBaseMs?: number, retryCapMs?: number, retryAfterCapMs?: number,
 *   pollIntervalMs?: number, pollMaxIntervalMs?: number,
 *   maxApiResponseBytes?: number, maxDownloadBytes?: number,
 * }} [options]
 */
export function createApi(options = {}) {
  const {
    baseUrl = DEFAULT_BASE_URL,
    key,
    env = process.env,
    fetchImpl = globalThis.fetch,
    sleepImpl = sleep,
    nowImpl = () => Date.now(),
    randomImpl = Math.random,
    log = () => {},
  } = options;
  const base = baseUrl.replace(/\/+$/, '');
  const minIntervalMs = options.minIntervalMs ?? envNumber('MOTH_MIN_INTERVAL_MS', DEFAULT_MIN_INTERVAL_MS, env);
  const maxRetries = options.maxRetries ?? envNumber('MOTH_MAX_RETRIES', DEFAULT_MAX_RETRIES, env);
  const retryBaseMs = options.retryBaseMs ?? envNumber('MOTH_RETRY_BASE_MS', DEFAULT_RETRY_BASE_MS, env);
  const retryCapMs = options.retryCapMs ?? envNumber('MOTH_RETRY_CAP_MS', DEFAULT_RETRY_CAP_MS, env);
  const retryAfterCapMs = options.retryAfterCapMs ?? DEFAULT_RETRY_AFTER_CAP_MS;
  const pollIntervalMs = options.pollIntervalMs ?? envNumber('MOTH_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS, env);
  const pollMaxIntervalMs = options.pollMaxIntervalMs ?? envNumber('MOTH_POLL_MAX_INTERVAL_MS', DEFAULT_POLL_MAX_INTERVAL_MS, env);
  const maxApiResponseBytes = byteLimit(options.maxApiResponseBytes ?? DEFAULT_MAX_API_RESPONSE_BYTES, 'maxApiResponseBytes');
  const maxDownloadBytes = byteLimit(options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES, 'maxDownloadBytes');

  // Concurrency-1 gate: request starts are serialized and spaced by at least
  // `minIntervalMs` (start-to-start, so the client never exceeds 1/interval).
  let queue = Promise.resolve();
  let nextStart = 0;
  function gate(task) {
    const run = queue.then(async () => {
      const waitMs = nextStart - nowImpl();
      if (waitMs > 0) await sleepImpl(waitMs);
      nextStart = nowImpl() + minIntervalMs;
      return task();
    });
    queue = run.then(() => {}, () => {});
    return run;
  }

  async function request(pathname, { method = 'GET', body, raw = false, headers = {}, allowNotModified = false, submit = false } = {}) {
    const label = `${method} ${pathname}`;
    let retries = 0;
    for (;;) {
      let response;
      let text;
      try {
        ({ response, text } = await gate(async () => {
          const res = await fetchImpl(base + pathname, {
            method,
            headers: {
              ...(key ? { Authorization: `Bearer ${key}` } : {}),
              ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
              ...headers,
            },
            body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
          });
          return { response: res, text: (await readLimited(res, maxApiResponseBytes, 'API response')).toString('utf8') };
        }));
      } catch (error) {
        // A submit that dies on the wire may already have created a paid job:
        // fail closed, never auto-retry it.
        if (submit) throw submitAmbiguousError(label, error instanceof ApiError ? error.message : 'request failed', error);
        if (!isTransientNetworkError(error) || retries >= maxRetries) {
          if (error instanceof ApiError) throw error;
          throw new Error(safeDetail(error.message, key) || 'request failed');
        }
        retries += 1;
        const waitMs = backoffMs(retries, retryBaseMs, retryCapMs, randomImpl);
        log(`  ${label} failed (network error), retrying in ${formatWait(waitMs)} (attempt ${retries}/${maxRetries})`);
        await sleepImpl(waitMs);
        continue;
      }
      const retryable = submit ? response.status === 429 : RETRYABLE_STATUS.has(response.status);
      if (retryable && retries < maxRetries) {
        retries += 1;
        const waitMs = parseRetryAfterMs(response.headers, nowImpl(), retryAfterCapMs) ?? backoffMs(retries, retryBaseMs, retryCapMs, randomImpl);
        log(`  rate limited, retrying in ${formatWait(waitMs)} (attempt ${retries}/${maxRetries})`);
        await sleepImpl(waitMs);
        continue;
      }
      if (raw) return { status: response.status, ok: response.ok, text };
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (!response.ok && !(allowNotModified && response.status === 304)) {
        const detail = safeDetail(json?.detail || json?.title, key);
        const suffix = retryable ? ` (rate limited; gave up after ${maxRetries} retr${maxRetries === 1 ? 'y' : 'ies'})` : '';
        const error = new ApiError(`${label} -> ${response.status}${detail ? `: ${detail}` : ''}${suffix}`, {
          status: response.status,
          body: json,
        });
        // A 5xx on a submit is ambiguous: the job may exist even though the
        // response failed. Refuse to guess; tell the user how to check.
        if (submit && response.status >= 500) throw submitAmbiguousError(label, `HTTP ${response.status}${detail ? `: ${detail}` : ''}`, error);
        throw error;
      }
      return json ?? { status: response.status, ok: response.ok, text };
    }
  }

  async function listEngines() {
    const body = await request('/api/v1/engines');
    return body.engines || body.items || body.data || body;
  }

  async function getEngine(engineId) {
    return request(`/api/v1/engines/${encodeURIComponent(engineId)}`);
  }

  async function submitJob(engineId, jobOptions = {}) {
    const { params = {}, inputFiles, mode } = jobOptions;
    const body = { params };
    if (inputFiles) body.input_files = inputFiles;
    if (mode) body.mode = mode;
    return request(`/api/v1/engines/${encodeURIComponent(engineId)}/process`, { method: 'POST', body, submit: true });
  }

  async function jobStatus(jobId) {
    return request(`/api/v1/jobs/${encodeURIComponent(jobId)}/status`);
  }

  async function jobResult(jobId) {
    return request(`/api/v1/jobs/${encodeURIComponent(jobId)}/result`);
  }

  /**
   * Poll a job until it completes. Logs status transitions, throws on
   * failed/cancelled/timeout with a descriptive message.
   *
   * Adaptive pacing: the first poll waits `intervalMs` (default 1500 ms); while
   * the status/progress marker does not change, the wait grows by 1.5x up to
   * `maxIntervalMs` (default 5000 ms); any transition resets it. The overall
   * `timeoutMs` is unchanged.
   */
  async function waitForJob(jobId, waitOptions = {}) {
    const timeoutMs = waitOptions.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    const baseIntervalMs = waitOptions.intervalMs ?? pollIntervalMs;
    const maxIntervalMs = Math.max(baseIntervalMs, waitOptions.maxIntervalMs ?? pollMaxIntervalMs);
    const waitLog = waitOptions.log ?? log;
    const started = nowImpl();
    let last = null;
    let intervalMs = baseIntervalMs;
    for (;;) {
      const status = await jobStatus(jobId);
      const marker = `${status.status}:${status.progress?.step || ''}`;
      if (marker !== last) {
        last = marker;
        intervalMs = baseIntervalMs;
        const step = status.progress?.step ? ` (${status.progress.step})` : '';
        const detail = status.progress?.detail ? ` — ${status.progress.detail}` : '';
        waitLog(`  ${status.status}${step}${detail}`);
      } else {
        intervalMs = Math.min(maxIntervalMs, Math.round(intervalMs * 1.5));
      }
      if (status.status === 'completed') return status;
      if (status.status === 'failed' || status.status === 'cancelled') {
        const message = status.error?.message || status.error?.type || 'unknown error';
        const error = new ApiError(`job ${jobId} ${status.status}: ${message}`, { status: status.status, body: status.error });
        throw error;
      }
      if (nowImpl() - started >= timeoutMs) {
        throw new Error(`job ${jobId} timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      await sleepImpl(intervalMs);
    }
  }

  /** Upload a local file through create -> presigned PUT -> complete. */
  async function uploadAsset(filePath, uploadOptions = {}) {
    const bytes = fs.readFileSync(filePath);
    const contentType = uploadOptions.contentType || guessContentType(filePath);
    const created = await request('/api/v1/assets', {
      method: 'POST',
      body: { filename: path.basename(filePath), content_type: contentType, size_bytes: bytes.length },
    });
    const upload = created.upload;
    if (!upload?.url) throw new Error(`asset ${created.asset_id}: no presigned upload returned`);
    const response = await fetchImpl(upload.url, {
      method: upload.method || 'PUT',
      headers: upload.headers || {},
      body: bytes,
    });
    if (!response.ok) throw new Error(`asset upload -> ${response.status}`);
    await request(`/api/v1/assets/${encodeURIComponent(created.asset_id)}/complete`, { method: 'POST', body: {} });
    return created.asset_id;
  }

  /**
   * Download an output to a Buffer. `res.ok` is always enforced; pass the
   * declared `contentType` from the job result to also enforce that the server
   * served what it promised, and empty bodies are always rejected so a failed
   * download cannot silently become an empty artifact.
   */
  async function downloadOutput(url, downloadOptions = {}) {
    let response;
    try {
      response = await fetchImpl(url);
    } catch {
      throw new Error('download: request failed');
    }
    if (!response.ok) {
      try { await response.body?.cancel?.(); } catch { /* Ignore cancellation errors. */ }
      throw new Error(`download -> ${response.status}`);
    }
    const declared = normalizeContentType(downloadOptions.contentType);
    const actual = normalizeContentType(response.headers?.get?.('content-type'));
    if (declared && actual !== declared) {
      const safeType = (type) => /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) ? type : '(none)';
      try { await response.body?.cancel?.(); } catch { /* Ignore cancellation errors. */ }
      throw new Error(`download: content-type "${safeType(actual)}" does not match the declared "${safeType(declared)}"`);
    }
    let buffer;
    try {
      buffer = await readLimited(response, maxDownloadBytes, 'download');
    } catch (error) {
      if (error instanceof ApiError && error.message === `download exceeds ${maxDownloadBytes} byte limit`) throw error;
      throw new Error('download: body read failed');
    }
    if (!buffer.length) throw new Error('download: empty body');
    return buffer;
  }

  return {
    baseUrl: base,
    listEngines,
    getEngine,
    submitJob,
    jobStatus,
    jobResult,
    waitForJob,
    uploadAsset,
    downloadOutput,
    request,
    sleepImpl,
    minIntervalMs,
    maxRetries,
    retryBaseMs,
    retryCapMs,
    pollIntervalMs,
    pollMaxIntervalMs,
    maxApiResponseBytes,
    maxDownloadBytes,
  };
}
