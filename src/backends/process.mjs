// Explicit local process boundary. No shell, inherited credentials, or unbounded pipes.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_INPUT_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 120_000;
const MAX_PIPE_BYTES = 8 * 1024 * 1024;
const runner = fileURLToPath(new URL('../../python/mothbake_backends/runner.py', import.meta.url));

function limit(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive safe integer`);
  return value;
}

export class LocalProcessError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LocalProcessError';
    this.code = code;
  }
}

/** Run an explicitly chosen absolute executable, passing one bounded UTF-8 request on stdin. */
export async function runLocalProcess(options) {
  const { command, args = [], input = '', signal } = options ?? {};
  if (typeof command !== 'string' || !path.isAbsolute(command) || !Array.isArray(args)
    || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
    || typeof input !== 'string' || command.includes('\0')) {
    throw new TypeError('local process requires an absolute command, string args and string input');
  }
  const timeoutMs = limit(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs');
  const maxInputBytes = limit(options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES, 'maxInputBytes');
  const maxOutputBytes = limit(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, 'maxOutputBytes');
  if (timeoutMs > MAX_TIMEOUT_MS || maxInputBytes > MAX_PIPE_BYTES || maxOutputBytes > MAX_PIPE_BYTES) {
    throw new RangeError('local process limits exceed permitted maximum');
  }
  const request = Buffer.from(input, 'utf8');
  if (request.length > maxInputBytes) throw new LocalProcessError('local process input exceeds byte limit', 'INPUT_LIMIT');
  if (signal?.aborted) throw new LocalProcessError('local process aborted', 'ABORTED');
  // Only locale and PATH for interpreter startup; no credentials, proxy variables,
  // PYTHONPATH, site hooks or ambient runtime configuration cross this boundary.
  const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PYTHONNOUSERSITE: '1' };
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { shell: false, cwd: path.dirname(runner), env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    } catch {
      reject(new LocalProcessError('local process failed to start', 'SPAWN'));
      return;
    }
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    const stderr = [];
    const stop = (code, message) => {
      if (settled) return;
      settled = true;
      terminate();
      cleanup();
      reject(new LocalProcessError(message, code));
    };
    const terminate = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* Already exited. */ }
    };
    const onAbort = () => stop('ABORTED', 'local process aborted');
    const timer = setTimeout(() => stop('TIMEOUT', 'local process timed out'), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    for (const [stream, chunks, label] of [['stdout', stdout, 'stdout'], ['stderr', stderr, 'stderr']]) {
      child[stream].on('data', (chunk) => {
        if (settled) return;
        if (label === 'stdout') stdoutBytes += chunk.length;
        else stderrBytes += chunk.length;
        if (stdoutBytes + stderrBytes > maxOutputBytes) {
          stop('OUTPUT_LIMIT', 'local process output exceeds byte limit');
          return;
        }
        chunks.push(chunk);
      });
    }
    child.on('error', () => stop('SPAWN', 'local process failed to start'));
    child.on('close', (exitCode, exitSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (exitCode !== 0 || exitSignal) {
        terminate();
        reject(new LocalProcessError(`local process exited unsuccessfully (${exitSignal || exitCode})`, 'EXIT'));
      } else {
        resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
      }
    });
    child.stdin.on('error', () => { /* A premature close is reported by the exit handler. */ });
    child.stdin.end(request);
  });
}

/** Explicit Python shim; no implicit fallback to the hosted API. */
export async function runPythonBackend(request, { python, signal, timeoutMs, maxInputBytes, maxOutputBytes } = {}) {
  if (typeof python !== 'string' || !path.isAbsolute(python)) throw new TypeError('python must be an absolute interpreter path');
  const { stdout } = await runLocalProcess({
    command: python, args: ['-I', '-B', runner], input: JSON.stringify(request), signal,
    timeoutMs, maxInputBytes, maxOutputBytes,
  });
  let result;
  try { result = JSON.parse(stdout); } catch { throw new LocalProcessError('local backend returned invalid JSON', 'PROTOCOL'); }
  if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.ok !== 'boolean') {
    throw new LocalProcessError('local backend returned invalid response', 'PROTOCOL');
  }
  if (!result.ok) throw new LocalProcessError(`local backend: ${String(result.error || 'request failed').slice(0, 200)}`, 'BACKEND');
  return result;
}
