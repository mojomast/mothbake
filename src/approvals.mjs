// Explicit, content-pinned approvals. All writers must use this store on a
// single host; a leftover write lock fails closed rather than being stolen.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from './identity.mjs';

const VERSION = 1;
const SHA256 = /^[a-f0-9]{64}$/;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const validString = (value) => typeof value === 'string' && value.trim().length > 0;

function validEntry(entry) {
  if (!plain(entry) || !validString(entry.candidateId) || !SHA256.test(entry.planFingerprint)
    || !plain(entry.provenance) || !validString(entry.approvedAt)
    || Number.isNaN(Date.parse(entry.approvedAt))) throw new Error('invalid approval entry');
  for (const slot of ['source', 'result']) {
    if (!plain(entry[slot]) || !validString(entry[slot].path) || !SHA256.test(entry[slot].sha256)) {
      throw new Error(`invalid approval ${slot}`);
    }
  }
  canonicalJson(entry.provenance);
  if (entry.provenance.planFingerprint !== entry.planFingerprint) {
    throw new Error('approval planFingerprint does not match candidate provenance');
  }
  return entry;
}

function validateDocument(doc) {
  if (!plain(doc) || doc.version !== VERSION || !Array.isArray(doc.history)) {
    throw new Error('invalid approval lockfile (version or shape)');
  }
  validEntry(doc.approval);
  for (const entry of doc.history) validEntry(entry);
  return doc;
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function pinFile(root, label, slot) {
  if (!plain(slot) || !validString(slot.path) || !SHA256.test(slot.sha256)) {
    throw new TypeError(`${label} requires a path and lowercase SHA-256 hash`);
  }
  const file = path.resolve(root, slot.path);
  if (!inside(root, file)) throw new Error(`${label} path must be inside workspaceRoot`);
  const actual = await fs.realpath(file);
  const realRoot = await fs.realpath(root);
  if (!inside(realRoot, actual)) throw new Error(`${label} path escapes workspaceRoot`);
  const bytes = await fs.readFile(actual);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== slot.sha256) throw new Error(`${label} SHA-256 mismatch`);
  return { path: slot.path, sha256: digest };
}

async function readDocument(file) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try { return validateDocument(JSON.parse(text)); }
  catch (error) { throw new Error(`corrupt approval lockfile: ${error.message}`, { cause: error }); }
}

async function writeAtomic(file, doc) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(doc, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * get() returns the current approval or null; history() returns superseded
 * approvals, oldest first. approve() only creates the initial approval;
 * supersede() requires one and preserves it in history. Both return the new
 * approval. Paths may be relative to workspaceRoot or absolute beneath it.
 */
export function createApprovalStore({ workspaceRoot }) {
  if (!validString(workspaceRoot)) throw new TypeError('workspaceRoot must be a path');
  const root = path.resolve(workspaceRoot);
  const file = path.join(root, 'approval.lock.json');
  const lock = `${file}.write-lock`;

  async function update(candidate, planFingerprint, replace) {
    if (!plain(candidate) || !validString(candidate.id) || !plain(candidate.provenance)) {
      throw new TypeError('candidate requires id and provenance');
    }
    canonicalJson(candidate.provenance);
    if (!SHA256.test(planFingerprint)) throw new TypeError('planFingerprint must be a lowercase SHA-256 hash');
    if (candidate.rejected === true) throw new Error('rejected candidate cannot be approved');
    if (candidate.provenance.planFingerprint !== planFingerprint) {
      throw new Error('planFingerprint does not match candidate provenance');
    }
    await fs.mkdir(root, { recursive: true });
    let handle;
    // Wait briefly for a cooperating writer; never break an unknown/stale lock.
    for (let attempt = 0; attempt < 100; attempt++) {
      try { handle = await fs.open(lock, 'wx', 0o600); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (attempt === 99) throw new Error('approval lock is held; retry later', { cause: error });
        await pause(20);
      }
    }
    try {
      const prior = await readDocument(file);
      if (replace ? !prior : !!prior) {
        throw new Error(replace ? 'supersede requires an existing approval' : 'approval already exists; use supersede');
      }
      const source = await pinFile(root, 'source', candidate.source);
      const result = await pinFile(root, 'result', candidate.result);
      const approval = {
        candidateId: candidate.id, source, result, planFingerprint,
        provenance: structuredClone(candidate.provenance), approvedAt: new Date().toISOString(),
      };
      const next = { version: VERSION, approval, history: prior ? [...prior.history, prior.approval] : [] };
      await writeAtomic(file, next);
      return structuredClone(approval);
    } finally {
      await handle.close();
      await fs.unlink(lock);
    }
  }

  return {
    async get() { const doc = await readDocument(file); return doc ? structuredClone(doc.approval) : null; },
    async history() { const doc = await readDocument(file); return doc ? structuredClone(doc.history) : []; },
    approve(candidate, planFingerprint) { return update(candidate, planFingerprint, false); },
    supersede(candidate, planFingerprint) { return update(candidate, planFingerprint, true); },
  };
}
