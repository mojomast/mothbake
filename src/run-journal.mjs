// Single-host, synchronous run journal. Call close() in a finally block.
// Files in outDir: run-journal.json and run-journal.lock. The lock is advisory:
// all writers must use this API. Do not use on a shared/network filesystem.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJson } from './identity.mjs';

export const JOURNAL_VERSION = 1;
export const RUN_STATES = Object.freeze([
  'prepared', 'submitting', 'submitted', 'polling', 'completed',
  'downloaded', 'baked', 'published', 'remote-failed', 'local-failed',
  'unknown-submission',
]);
const STATES = new Set(RUN_STATES);
const JOURNAL_FILE = 'run-journal.json';
const LOCK_FILE = 'run-journal.lock';
// A short-lived acquisition mutex serializes *all* cooperating lock creators,
// breakers, and releasers. Without it a breaker can unlink a newly-created
// owner's lock after checking the stale inode but before unlinking it.
const ACQUIRE_FILE = 'run-journal.acquire.lock';
const MAX_HISTORY = 32;
const DEFAULT_STALE_AFTER_MS = 60 * 60 * 1000;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const keysAre = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));
const validTime = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const validId = (value) => typeof value === 'string' && value.length > 0;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

function validateJournal(data) {
  if (!plain(data) || !keysAre(data, ['version', 'jobs']) || data.version !== JOURNAL_VERSION || !plain(data.jobs)) throw new Error('invalid run journal (version or shape)');
  for (const [id, job] of Object.entries(data.jobs)) {
    if (!validId(id) || !plain(job) || !keysAre(job, ['state', 'jobId', 'metadata', 'history']) || !STATES.has(job.state)
      || !(job.jobId === null || validId(job.jobId)) || !Array.isArray(job.history)
      || job.history.length < 1 || job.history.length > MAX_HISTORY) throw new Error(`invalid run journal job: ${id}`);
    if (!plain(job.metadata)) throw new Error(`invalid run journal metadata: ${id}`);
    try { canonicalJson(job.metadata); } catch (error) { throw new Error(`invalid run journal metadata: ${id}: ${error.message}`); }
    for (const entry of job.history) {
      if (!plain(entry) || !keysAre(entry, ['state', 'at', 'detail']) || !STATES.has(entry.state)
        || !validTime(entry.at) || (entry.detail !== undefined && typeof entry.detail !== 'string')) throw new Error(`invalid run journal history: ${id}`);
    }
    if (job.history.at(-1).state !== job.state || (job.state === 'submitted' && !job.jobId)) throw new Error(`invalid run journal state: ${id}`);
  }
  return data;
}

function validateLock(value) {
  if (!plain(value) || !keysAre(value, ['token', 'pid', 'hostname', 'createdAt'])
    || !validId(value.token) || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || !validId(value.hostname) || !Number.isFinite(value.createdAt) || value.createdAt < 0) throw new Error('invalid run journal lock');
  return value;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; } // EPERM means possibly alive.
}

function readLock(file) {
  try {
    const stat = fs.statSync(file);
    const value = validateLock(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (!sameFile(stat, fs.statSync(file))) throw new Error('run journal lock changed while reading');
    return { stat, value };
  } catch (error) {
    if (error.code === 'ENOENT') throw error;
    if (/run journal lock changed/.test(error.message)) throw error;
    throw new Error(`invalid run journal lock: ${error.message}`, { cause: error });
  }
}

function releaseOwned(file, token, inode) {
  try {
    const current = readLock(file);
    if (!sameFile(current.stat, inode) || current.value.token !== token) throw new Error('run journal lock is no longer owned');
    fs.unlinkSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('run journal lock is no longer owned', { cause: error });
    throw error;
  }
}

function withAcquisitionLock(outDir, action) {
  const file = path.join(outDir, ACQUIRE_FILE);
  const token = randomUUID();
  try {
    fs.writeFileSync(file, token, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('run journal acquisition locked; retry after the other writer finishes');
    throw error;
  }
  const inode = fs.statSync(file);
  try {
    return action();
  } finally {
    // Never remove a replacement guard created by an uncooperative writer.
    const current = fs.statSync(file);
    if (!sameFile(inode, current) || fs.readFileSync(file, 'utf8') !== token) throw new Error('run journal acquisition lock is no longer owned');
    fs.unlinkSync(file);
  }
}

function writeAtomic(file, data) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

/** Read a journal snapshot without taking the writer lock; intended for plans/status. */
export function readRunJournal(outDir) {
  const file = path.join(outDir, JOURNAL_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    return structuredClone(validateJournal(JSON.parse(fs.readFileSync(file, 'utf8'))));
  } catch (error) {
    throw new Error(`corrupt run journal: ${error.message}`, { cause: error });
  }
}

/**
 * Open the exclusive journal for `outDir`. Options: `clock` (epoch-ms function),
 * `pid`, `hostname`, `isProcessAlive(pid)`, `staleAfterMs` (default 1 hour), and
 * `breakLock` (default false). A stale lock can only be broken explicitly when
 * it belongs to this hostname, is at least staleAfterMs old, and its PID is
 * confirmed dead. Corrupt locks always fail closed. Never share outDir between
 * hosts; filesystem locks here are not distributed locks.
 *
 * get(id) returns a copy or null; snapshot() returns a copy of the full file.
 * transition(id, state, { jobId?, detail?, metadata? }) persists a new state and returns
 * the job copy. Omitted jobId retains the previous remote ID, even on failures.
 * `unknown-submission` records ambiguity after a submit request without a
 * trustworthy response; callers must reconcile it before submitting again.
 * close() releases only this instance's lock. Each history keeps 32 entries.
 */
export function openRunJournal(outDir, options = {}) {
  const { clock = Date.now, pid = process.pid, hostname = os.hostname(),
    isProcessAlive = alive, staleAfterMs = DEFAULT_STALE_AFTER_MS, breakLock = false } = options;
  if (!Number.isSafeInteger(pid) || pid <= 0 || !validId(hostname) || !Number.isFinite(staleAfterMs) || staleAfterMs < 0) throw new TypeError('invalid run journal lock options');
  const now = () => {
    const value = clock();
    if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(value)) throw new TypeError('journal clock must return epoch milliseconds');
    return value;
  };
  fs.mkdirSync(outDir, { recursive: true });
  const journalFile = path.join(outDir, JOURNAL_FILE);
  const lockFile = path.join(outDir, LOCK_FILE);
  const token = randomUUID();
  const owner = { token, pid, hostname, createdAt: now() };
  let inode;
  withAcquisitionLock(outDir, () => {
    try {
      fs.writeFileSync(lockFile, `${JSON.stringify(owner)}\n`, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = readLock(lockFile);
      if (!breakLock) throw new Error(`run journal locked by ${previous.value.hostname}:${previous.value.pid}; pass breakLock to break a stale lock`);
      if (previous.value.hostname !== hostname || now() - previous.value.createdAt < staleAfterMs || isProcessAlive(previous.value.pid)) {
        throw new Error('run journal lock is active or cannot be confirmed stale on this host');
      }
      const current = readLock(lockFile);
      if (!sameFile(previous.stat, current.stat) || current.value.token !== previous.value.token) throw new Error('run journal lock changed while breaking');
      fs.unlinkSync(lockFile);
      fs.writeFileSync(lockFile, `${JSON.stringify(owner)}\n`, { flag: 'wx', mode: 0o600 });
    }
    inode = fs.statSync(lockFile);
  });
  let closed = false;
  let data;
  try {
    try { data = validateJournal(JSON.parse(fs.readFileSync(journalFile, 'utf8'))); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`corrupt run journal: ${error.message}`, { cause: error });
      data = { version: JOURNAL_VERSION, jobs: {} };
      writeAtomic(journalFile, data);
    }
  } catch (error) {
    withAcquisitionLock(outDir, () => releaseOwned(lockFile, token, inode));
    throw error;
  }
  const assertOpen = () => {
    if (closed) throw new Error('run journal is closed');
    const current = readLock(lockFile);
    if (!sameFile(current.stat, inode) || current.value.token !== token) throw new Error('run journal lock is no longer owned');
  };
  const copy = (value) => structuredClone(value);
  return {
    get(id) { assertOpen(); return Object.hasOwn(data.jobs, id) ? copy(data.jobs[id]) : null; },
    snapshot() { assertOpen(); return copy(data); },
    transition(id, state, { jobId, detail, metadata } = {}) {
      assertOpen();
      if (!validId(id) || !STATES.has(state) || (jobId !== undefined && !validId(jobId)) || (detail !== undefined && typeof detail !== 'string')) throw new TypeError('invalid run journal transition');
      if (metadata !== undefined) {
        if (!plain(metadata)) throw new TypeError('run journal metadata must be a plain object');
        canonicalJson(metadata);
      }
      const prior = Object.hasOwn(data.jobs, id) ? data.jobs[id] : null;
      if (state === 'submitted' && !(jobId ?? prior?.jobId)) throw new Error('submitted requires a jobId');
      const entry = { state, at: new Date(now()).toISOString() };
      if (detail !== undefined) entry.detail = detail;
      const nextJob = {
        state,
        jobId: jobId ?? prior?.jobId ?? null,
        metadata: { ...(prior?.metadata ?? {}), ...(metadata ?? {}) },
        history: [...(prior?.history ?? []), entry].slice(-MAX_HISTORY),
      };
      const next = { version: JOURNAL_VERSION, jobs: { ...data.jobs, [id]: nextJob } };
      writeAtomic(journalFile, next);
      data = next;
      return copy(nextJob);
    },
    close() {
      if (closed) return;
      withAcquisitionLock(outDir, () => releaseOwned(lockFile, token, inode));
      closed = true;
    },
  };
}
