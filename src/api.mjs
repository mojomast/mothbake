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

/**
 * Create a client bound to a base URL and (optional) key.
 *
 * @param {{ baseUrl?: string, key?: string, fetchImpl?: typeof fetch, sleepImpl?: (ms: number) => Promise<void>, log?: Function }} [options]
 */
export function createApi(options = {}) {
  const {
    baseUrl = DEFAULT_BASE_URL,
    key,
    fetchImpl = globalThis.fetch,
    sleepImpl = sleep,
    log = () => {},
  } = options;
  const base = baseUrl.replace(/\/+$/, '');

  async function request(pathname, { method = 'GET', body, raw = false, headers = {}, allowNotModified = false } = {}) {
    const response = await fetchImpl(base + pathname, {
      method,
      headers: {
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await response.text();
    if (raw) return { status: response.status, ok: response.ok, text };
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!response.ok && !(allowNotModified && response.status === 304)) {
      const detail = json?.detail || json?.title || text.slice(0, 200);
      throw new ApiError(`${method} ${pathname} -> ${response.status}${detail ? `: ${detail}` : ''}`, {
        status: response.status,
        body: json,
      });
    }
    return json ?? { status: response.status, ok: response.ok, text };
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
    return request(`/api/v1/engines/${encodeURIComponent(engineId)}/process`, { method: 'POST', body });
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
   */
  async function waitForJob(jobId, waitOptions = {}) {
    const timeoutMs = waitOptions.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    const intervalMs = waitOptions.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const waitLog = waitOptions.log ?? log;
    const started = Date.now();
    let last = null;
    for (;;) {
      const status = await jobStatus(jobId);
      const marker = `${status.status}:${status.progress?.step || ''}`;
      if (marker !== last) {
        last = marker;
        const step = status.progress?.step ? ` (${status.progress.step})` : '';
        const detail = status.progress?.detail ? ` — ${status.progress.detail}` : '';
        waitLog(`  ${status.status}${step}${detail}`);
      }
      if (status.status === 'completed') return status;
      if (status.status === 'failed' || status.status === 'cancelled') {
        const message = status.error?.message || status.error?.type || 'unknown error';
        const error = new ApiError(`job ${jobId} ${status.status}: ${message}`, { status: status.status, body: status.error });
        throw error;
      }
      if (Date.now() - started >= timeoutMs) {
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

  async function downloadOutput(url) {
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`download ${url} -> ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  return { baseUrl: base, listEngines, getEngine, submitJob, jobStatus, jobResult, waitForJob, uploadAsset, downloadOutput, request };
}
