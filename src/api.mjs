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
export const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
export const DEFAULT_UPLOAD_TIMEOUT_MS = 120000;
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120000;
const MAX_DOWNLOAD_REDIRECTS = 5;
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

// Only GETs may retry transient server responses. POSTs retry only a definite 429.
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
  return error.name === 'TypeError' || error.name === 'TimeoutError';
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
  error.operationKind = 'submit';
  return error;
}

function assetAmbiguousError(label, cause) {
  const error = new ApiError(`${label} did not confirm the asset operation. The asset may or may not have been created or completed — inspect the asset list before retrying manually.`, {
    status: cause?.status ?? null, body: cause?.body ?? null,
  });
  error.ambiguous = true;
  error.operationKind = 'asset';
  return error;
}

function abortError(signal, label) {
  const timeout = signal?.reason?.name === 'TimeoutError';
  const error = new ApiError(`${label}: ${timeout ? 'deadline exceeded' : 'aborted'}`);
  error.timeout = timeout;
  return error;
}

function abortable(promise, signal, label) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal, label));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal, label));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function withDeadline(signal, timeoutMs, label, task) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Deadline exceeded', 'TimeoutError')), timeoutMs);
  try {
    if (controller.signal.aborted) throw abortError(controller.signal, label);
    return await abortable(task(controller.signal), controller.signal, label);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function queryString(params = {}) {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value == null) continue;
    if (Array.isArray(value)) value.forEach((item) => query.append(name, String(item)));
    else query.append(name, String(value));
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : '';
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

async function readLimited(response, limit, kind, signal) {
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
        const { done, value } = await abortable(reader.read(), signal, kind);
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
    ? Buffer.from(await abortable(response.text(), signal, kind), 'utf8')
    : Buffer.from(await abortable(response.arrayBuffer(), signal, kind));
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
  * jittered). GETs retry 429, transient 5xx and network failures;
  * POSTs retry only 429 because other outcomes may be ambiguous.
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
  *   requestTimeoutMs?: number, uploadTimeoutMs?: number, downloadTimeoutMs?: number,
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
  const maxUploadBytes = byteLimit(options.maxUploadBytes ?? envNumber('MOTH_MAX_UPLOAD_BYTES', DEFAULT_MAX_UPLOAD_BYTES, env), 'maxUploadBytes');
  const requestTimeoutMs = byteLimit(options.requestTimeoutMs ?? envNumber('MOTH_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS, env), 'requestTimeoutMs');
  const uploadTimeoutMs = byteLimit(options.uploadTimeoutMs ?? envNumber('MOTH_UPLOAD_TIMEOUT_MS', DEFAULT_UPLOAD_TIMEOUT_MS, env), 'uploadTimeoutMs');
  const downloadTimeoutMs = byteLimit(options.downloadTimeoutMs ?? envNumber('MOTH_DOWNLOAD_TIMEOUT_MS', DEFAULT_DOWNLOAD_TIMEOUT_MS, env), 'downloadTimeoutMs');

  // Concurrency-1 gate: request starts are serialized and spaced by at least
  // `minIntervalMs` (start-to-start, so the client never exceeds 1/interval).
  let queue = Promise.resolve();
  let nextStart = 0;
  function gate(task, signal, label) {
    const run = queue.then(async () => {
      if (signal?.aborted) throw abortError(signal, label);
      const waitMs = nextStart - nowImpl();
      if (waitMs > 0) await abortable(sleepImpl(waitMs), signal, label);
      if (signal?.aborted) throw abortError(signal, label);
      nextStart = nowImpl() + minIntervalMs;
      return task();
    });
    queue = run.then(() => {}, () => {});
    return run;
  }

  async function request(pathname, { method = 'GET', body, raw = false, headers = {}, allowNotModified = false, submit = false, asset = false, signal } = {}) {
    const label = `${method} ${String(pathname).split('?')[0]}`;
    const postKind = submit ? 'submit' : asset ? 'asset' : null;
    let dispatched = false;
    try {
    return await withDeadline(signal, requestTimeoutMs, label, async (activeSignal) => {
    let retries = 0;
    for (;;) {
      let response;
      let text;
      let networkFailure = false;
      try {
        ({ response, text } = await gate(async () => {
          if (activeSignal.aborted) throw abortError(activeSignal, label);
          dispatched = true;
          let res;
          try {
            res = await abortable(fetchImpl(base + pathname, {
            method,
            redirect: 'manual',
            signal: activeSignal,
            headers: {
              ...(key ? { Authorization: `Bearer ${key}` } : {}),
              ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
              ...headers,
            },
            body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
            }), activeSignal, label);
          } catch (error) {
            networkFailure = true;
            throw error;
          }
          if (res.status >= 300 && res.status < 400 && !(allowNotModified && res.status === 304)) {
            try { await res.body?.cancel?.(); } catch { /* Preserve redirect rejection. */ }
            throw new ApiError(`${label} -> ${res.status}: API redirect rejected`, { status: res.status });
          }
          return { response: res, text: (await readLimited(res, maxApiResponseBytes, 'API response', activeSignal)).toString('utf8') };
        }, activeSignal, label));
      } catch (error) {
        if (activeSignal.aborted) throw abortError(activeSignal, label);
        if (error instanceof ApiError && /API redirect rejected/.test(error.message)) throw error;
        // A submit that dies on the wire may already have created a paid job:
        // fail closed, never auto-retry it.
        if (postKind) {
          if (postKind === 'asset') throw assetAmbiguousError(label, error);
          throw submitAmbiguousError(label, 'request failed', error);
        }
        if (method !== 'GET' || !networkFailure || !isTransientNetworkError(error) || retries >= maxRetries) {
          if (error instanceof ApiError) throw error;
          throw new ApiError(`${label}: ${safeDetail(error.message, key) || 'request failed'}`);
        }
        retries += 1;
        const waitMs = backoffMs(retries, retryBaseMs, retryCapMs, randomImpl);
        log(`  ${label} failed (network error), retrying in ${formatWait(waitMs)} (attempt ${retries}/${maxRetries})`);
        await abortable(sleepImpl(waitMs), activeSignal, label);
        continue;
      }
      const retryable = method === 'GET' ? RETRYABLE_STATUS.has(response.status) : response.status === 429;
      if (retryable && retries < maxRetries) {
        retries += 1;
        const waitMs = parseRetryAfterMs(response.headers, nowImpl(), retryAfterCapMs) ?? backoffMs(retries, retryBaseMs, retryCapMs, randomImpl);
        log(`  rate limited, retrying in ${formatWait(waitMs)} (attempt ${retries}/${maxRetries})`);
        await abortable(sleepImpl(waitMs), activeSignal, label);
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
          body: detail ? { detail } : null,
        });
        // A 5xx on a submit is ambiguous: the job may exist even though the
        // response failed. Refuse to guess; tell the user how to check.
        if (submit && response.status >= 500) throw submitAmbiguousError(label, `HTTP ${response.status}${detail ? `: ${detail}` : ''}`, error);
        if (asset && response.status >= 500) throw assetAmbiguousError(label, error);
        throw error;
      }
      return json ?? { status: response.status, ok: response.ok, text };
    }
    });
    } catch (error) {
      if (postKind && dispatched && (error.timeout || signal?.aborted)) {
        if (postKind === 'asset') throw assetAmbiguousError(label, error);
        throw submitAmbiguousError(label, error.timeout ? 'deadline exceeded' : 'local wait aborted after dispatch', error);
      }
      throw error;
    }
  }

  async function listEngines(options = {}) {
    const body = await request('/api/v1/engines', options);
    return body.engines || body.items || body.data || body;
  }

  async function getEngine(engineId, options = {}) {
    return request(`/api/v1/engines/${encodeURIComponent(engineId)}`, options);
  }

  async function submitJob(engineId, jobOptions = {}) {
    const { params = {}, inputFiles, mode, signal } = jobOptions;
    const body = { params };
    if (inputFiles) body.input_files = inputFiles;
    if (mode) body.mode = mode;
    return request(`/api/v1/engines/${encodeURIComponent(engineId)}/process`, { method: 'POST', body, submit: true, signal });
  }

  async function jobStatus(jobId, options = {}) {
    return request(`/api/v1/jobs/${encodeURIComponent(jobId)}/status`, options);
  }

  async function jobResult(jobId, options = {}) {
    return request(`/api/v1/jobs/${encodeURIComponent(jobId)}/result`, options);
  }

  async function listJobs(params = {}, options = {}) {
    return request(`/api/v1/jobs${queryString(params)}`, options);
  }

  async function getJob(jobId, options = {}) {
    return request(`/api/v1/jobs/${encodeURIComponent(jobId)}`, options);
  }

  async function listAssets(params = {}, options = {}) {
    return request(`/api/v1/assets${queryString(params)}`, options);
  }

  async function getAsset(assetId, options = {}) {
    return request(`/api/v1/assets/${encodeURIComponent(assetId)}`, options);
  }

  async function getAssetDownload(assetId, options = {}) {
    return request(`/api/v1/assets/${encodeURIComponent(assetId)}/download`, options);
  }

  async function getStorageUsage(options = {}) {
    return request('/api/v1/me/storage', options);
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
      if (waitOptions.signal?.aborted) throw abortError(waitOptions.signal, 'job wait');
      const status = await jobStatus(jobId, { signal: waitOptions.signal });
      const marker = `${status.status}:${status.progress?.step || ''}`;
      if (marker !== last) {
        last = marker;
        intervalMs = baseIntervalMs;
        const step = safeDetail(status.progress?.step, key);
        const detail = safeDetail(status.progress?.detail, key);
        waitLog(`  ${safeDetail(status.status, key) || 'unknown'}${step ? ` (${step})` : ''}${detail ? ` — ${detail}` : ''}`);
      } else {
        intervalMs = Math.min(maxIntervalMs, Math.round(intervalMs * 1.5));
      }
      if (status.status === 'completed') return status;
      if (status.status === 'failed' || status.status === 'cancelled') {
        const message = safeDetail(status.error?.message || status.error?.type, key) || 'unknown error';
        const error = new ApiError(`job ${safeDetail(String(jobId), key) || '(unknown)'} ${status.status}: ${message}`, { status: status.status, body: { detail: message } });
        throw error;
      }
      if (nowImpl() - started >= timeoutMs) {
        throw new Error(`job wait timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      await abortable(sleepImpl(intervalMs), waitOptions.signal, 'job wait');
    }
  }

  /** Upload a local file through create -> presigned PUT -> complete. */
  async function uploadAsset(filePath, uploadOptions = {}) {
    if (uploadOptions.signal?.aborted) throw abortError(uploadOptions.signal, 'asset upload');
    const handle = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let bytes;
    try {
      const stat = fs.fstatSync(handle);
      if (!stat.isFile() || stat.size <= 0 || stat.size > maxUploadBytes) throw new ApiError(`asset upload must be a regular non-empty file no larger than ${maxUploadBytes} bytes`);
      bytes = fs.readFileSync(handle);
    } finally { fs.closeSync(handle); }
    const contentType = uploadOptions.contentType || guessContentType(filePath);
    const created = await request('/api/v1/assets', {
      method: 'POST',
      body: { filename: path.basename(filePath), content_type: contentType, size_bytes: bytes.length },
      asset: true, signal: uploadOptions.signal,
    });
    const upload = created.upload;
    if (!upload?.url) throw new ApiError('asset: no presigned upload returned');
    try {
    await withDeadline(uploadOptions.signal, uploadTimeoutMs, 'asset upload', async (signal) => {
      let response;
      try {
        response = await abortable(fetchImpl(upload.url, {
          method: upload.method || 'PUT', headers: upload.headers || {}, body: bytes,
          signal, redirect: 'manual',
        }), signal, 'asset upload');
      } catch (error) {
        if (signal.aborted) throw abortError(signal, 'asset upload');
        throw new ApiError('asset upload: request failed');
      }
      if (!response.ok) {
        try { await response.body?.cancel?.(); } catch { /* Preserve HTTP error. */ }
        throw new ApiError(`asset upload -> ${response.status}`, { status: response.status });
      }
      try { await response.body?.cancel?.(); } catch { /* Ignore optional upload response. */ }
    });
    } catch (cause) {
      const error = new ApiError(`asset ${created.asset_id} upload did not complete; inspect or delete the pending asset before registering another upload`, { status: cause?.status ?? null });
      error.ambiguous = true;
      error.operationKind = 'asset-upload';
      error.assetId = created.asset_id;
      throw error;
    }
    try {
      await request(`/api/v1/assets/${encodeURIComponent(created.asset_id)}/complete`, { method: 'POST', body: {}, asset: true, signal: uploadOptions.signal });
    } catch (error) {
      error.assetId = created.asset_id;
      throw error;
    }
    return created.asset_id;
  }

  /**
   * Download an output to a Buffer. `res.ok` is always enforced; pass the
   * declared `contentType` from the job result to also enforce that the server
   * served what it promised, and empty bodies are always rejected so a failed
   * download cannot silently become an empty artifact.
   */
  async function downloadOutput(url, downloadOptions = {}) {
    return withDeadline(downloadOptions.signal, downloadTimeoutMs, 'download', async (signal) => {
    let response;
    let current;
    try {
      const target = new URL(url);
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('invalid URL');
      current = target.href;
    } catch {
      throw new ApiError('download: invalid URL');
    }
    for (let redirects = 0; ; redirects++) {
      try {
        response = await abortable(fetchImpl(current, { redirect: 'manual', signal }), signal, 'download');
      } catch {
        if (signal.aborted) throw abortError(signal, 'download');
        throw new ApiError('download: request failed');
      }
      if (!(response.status >= 300 && response.status < 400)) break;
      const location = response.headers?.get?.('location');
      try { await response.body?.cancel?.(); } catch { /* Preserve redirect error. */ }
      if (redirects >= MAX_DOWNLOAD_REDIRECTS || !location) throw new ApiError('download: redirect rejected');
      let next;
      try { next = new URL(location, current); } catch { throw new ApiError('download: redirect rejected'); }
      const previous = new URL(current);
      if (!['http:', 'https:'].includes(next.protocol) || (previous.protocol === 'https:' && next.protocol !== 'https:')
        || next.username || next.password) throw new ApiError('download: redirect rejected');
      current = next.href;
    }
    if (!response.ok) {
      try { await response.body?.cancel?.(); } catch { /* Ignore cancellation errors. */ }
      throw new ApiError(`download -> ${response.status}`, { status: response.status });
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
      buffer = await readLimited(response, maxDownloadBytes, 'download', signal);
    } catch (error) {
      if (signal.aborted) throw abortError(signal, 'download');
      if (error instanceof ApiError && error.message === `download exceeds ${maxDownloadBytes} byte limit`) throw error;
      throw new Error('download: body read failed');
    }
    if (!buffer.length) throw new Error('download: empty body');
    return buffer;
    });
  }

  async function refreshOutputAsset(assetId, downloadOptions = {}) {
    const fresh = await getAssetDownload(assetId, { signal: downloadOptions.signal });
    if (!fresh?.download_url) throw new ApiError('asset download: no fresh URL returned');
    return downloadOutput(fresh.download_url, downloadOptions);
  }

  return {
    baseUrl: base,
    listEngines,
    getEngine,
    submitJob,
    jobStatus,
    jobResult,
    listJobs,
    getJob,
    listAssets,
    getAsset,
    getAssetDownload,
    getStorageUsage,
    waitForJob,
    uploadAsset,
    downloadOutput,
    refreshOutputAsset,
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
    maxUploadBytes,
    requestTimeoutMs,
    uploadTimeoutMs,
    downloadTimeoutMs,
  };
}
