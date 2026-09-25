// Read-only evidence inventory. This module deliberately has no deletion API.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateCandidate } from './candidates.mjs';
import { hashJson, rawArtifactFingerprint } from './identity.mjs';

export const GC_REPORT_VERSION = 1;
const DEFAULTS = Object.freeze({ maxEntries: 20_000, maxDepth: 20, maxFileBytes: 64 * 1024 * 1024, maxJsonBytes: 2 * 1024 * 1024 });
const SHA = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const ARCHIVE = '.mothbake-archive.json';

function resolveRoot(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\\') || path.isAbsolute(rel) || path.win32.isAbsolute(rel)) throw new Error('invalid workspace-relative path');
  const target = path.resolve(root, rel);
  const back = path.relative(root, target);
  if (!back || back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) throw new Error('path escapes workspace');
  return target;
}

function readBytes(file, before, limit) {
  if (before.size > limit) throw new Error('file exceeds byte limit');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) throw new Error('file changed during inspection');
    const hash = createHash('sha256');
    const chunks = [];
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, stat.size)));
    let offset = 0;
    while (offset < stat.size) {
      const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - offset), offset);
      if (!n) throw new Error('file changed during inspection');
      hash.update(chunk.subarray(0, n));
      if (stat.size <= limit) chunks.push(Buffer.from(chunk.subarray(0, n)));
      offset += n;
    }
    const after = fs.fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino) throw new Error('file changed during inspection');
    return { sha256: hash.digest('hex'), bytes: stat.size, data: stat.size <= limit ? Buffer.concat(chunks, stat.size) : null };
  } finally { fs.closeSync(fd); }
}

/** Collect references and inventory without mutating the workspace. */
export function collectReferences(options = {}) {
  const { workspaceRoot, packRoots = ['delivery', 'audio-pack'], ...provided } = options;
  if (typeof workspaceRoot !== 'string' || !workspaceRoot) throw new TypeError('workspaceRoot is required');
  const limits = { ...DEFAULTS, ...provided };
  for (const [key, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${key} must be a positive safe integer`);
  if (!Array.isArray(packRoots)) throw new TypeError('packRoots must be an array');
  const root = path.resolve(workspaceRoot), rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('workspace root must be a real directory');
  const started = new Date().toISOString();
  const files = new Map(), refs = new Map(), expectedHashes = new Map(), unknowns = new Map(), warnings = [];
  let used = 0, bounded = false;
  const addRef = (p, kind, id, expectedHash = null) => {
    try { resolveRoot(root, p); } catch (e) { unknown(String(p), `unsafe referenced path: ${e.message}`); return; }
    if (!refs.has(p)) refs.set(p, new Map());
    refs.get(p).set(`${kind}\0${id}`, { kind, id });
    if (expectedHash) { if (!expectedHashes.has(p)) expectedHashes.set(p, new Set()); expectedHashes.get(p).add(expectedHash); }
  };
  const unknown = (p, reason) => {
    unknowns.set(p, reason);
    warnings.push(`${p}: ${reason}`);
  };
  const unavailable = (p, st, reason) => {
    unknown(p, reason);
    if (st?.isFile() && !files.has(p)) files.set(p, { path: p, bytes: st.size, sha256: null, stat: st });
  };
  const lstat = (p) => {
    try { return fs.lstatSync(resolveRoot(root, p)); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  };
  const hashFile = (p, limit = limits.maxFileBytes) => {
    const st = lstat(p);
    if (!st || !st.isFile() || st.isSymbolicLink()) throw new Error('not a regular non-symlink file');
    const body = readBytes(resolveRoot(root, p), st, limit);
    files.set(p, { path: p, bytes: body.bytes, sha256: body.sha256, stat: st });
    return body;
  };
  const walk = (base, depth = 0) => {
    if (depth > limits.maxDepth) { bounded = true; unknown(base, 'depth limit reached'); return; }
    let st;
    try { st = lstat(base); } catch (e) { unknown(base, `unreadable path: ${e.message}`); return; }
    if (!st) return;
    if (!st.isDirectory() || st.isSymbolicLink()) { unknown(base, 'unsafe or non-directory root'); return; }
    let children;
    try { children = fs.readdirSync(resolveRoot(root, base)).sort(); }
    catch (e) { unknown(base, `unreadable directory: ${e.message}`); return; }
    for (const name of children) {
      if (used >= limits.maxEntries) { bounded = true; unknown(base, 'entry limit reached'); return; }
      used++;
      const rel = `${base}/${name}`;
      let item;
      try { item = lstat(rel); } catch (e) { unknown(rel, `unreadable: ${e.message}`); continue; }
      if (!item) { unknown(rel, 'entry disappeared'); continue; }
      if (item.isSymbolicLink()) { unknown(rel, 'symlink refused'); continue; }
      if (item.isDirectory()) { walk(rel, depth + 1); continue; }
      if (!item.isFile()) { unknown(rel, 'unsupported filesystem entry'); continue; }
      try { hashFile(rel); } catch (e) { unavailable(rel, item, e.message); }
    }
  };
  for (const base of ['candidates', 'assets', 'raw']) walk(base);
  // Include metadata files as evidence too.
  for (const p of ['approval.lock.json', 'run-journal.json']) {
    const st = lstat(p);
    if (st) { try { hashFile(p, limits.maxJsonBytes); } catch (e) { unavailable(p, st, e.message); } }
  }

  // Candidates: invalid records make assets unclassifiable, never garbage.
  const candidateDir = lstat('candidates');
  if (candidateDir?.isDirectory() && !candidateDir.isSymbolicLink()) for (const name of fs.readdirSync(resolveRoot(root, 'candidates')).sort()) {
    if (used >= limits.maxEntries) { bounded = true; unknown('candidates', 'entry limit reached'); break; }
    const p = `candidates/${name}`;
    if (!name.endsWith('.json') || !ID.test(name.slice(0, -5))) { unknown(p, 'unrecognized candidate record'); continue; }
    try {
      const parsed = JSON.parse(hashFile(p, limits.maxJsonBytes).data.toString('utf8'));
      const c = validateCandidate(parsed);
      if (`${c.id}.json` !== name) throw new Error('candidate ID does not match filename');
      addRef(c.source.path, 'candidate-source', c.id, c.source.sha256);
      addRef(c.result.path, 'candidate-result', c.id, c.result.sha256);
    } catch (e) {
      unknown(p, `corrupt candidate: ${e.message}`);
      // A damaged reference record may name any asset under the workspace.
      for (const f of files.keys()) if (f.startsWith('assets/')) unknowns.set(f, 'candidate reference state is corrupt');
    }
  }

  // Approval current and historical pins.
  if (lstat('approval.lock.json')) try {
    const doc = JSON.parse(hashFile('approval.lock.json', limits.maxJsonBytes).data.toString('utf8'));
    if (doc?.version !== 1 || !doc.approval || !Array.isArray(doc.history)) throw new Error('invalid approval document');
    for (const [i, pin] of [doc.approval, ...doc.history].entries()) for (const role of ['source', 'result']) {
      const a = pin?.[role];
      if (!a || typeof a.path !== 'string' || !SHA.test(a.sha256)) throw new Error('invalid approval asset');
      addRef(a.path, `approval-${i === 0 ? 'current' : 'history'}`, String(i), a.sha256);
    }
  } catch (e) {
    unknown('approval.lock.json', `corrupt approval state: ${e.message}`);
    for (const f of files.keys()) if (f.startsWith('assets/')) unknowns.set(f, 'approval reference state is corrupt');
  }

  // A verified archive is identified by its manifest and each declared blob.
  const rawDir = lstat('raw');
  if (rawDir?.isDirectory() && !rawDir.isSymbolicLink()) for (const name of fs.readdirSync(resolveRoot(root, 'raw')).sort()) {
    if (used >= limits.maxEntries) { bounded = true; unknown('raw', 'entry limit reached'); break; }
    const dir = `raw/${name}`;
    const ds = lstat(dir);
    if (!ds?.isDirectory() || ds.isSymbolicLink()) continue;
    const manifestPath = `${dir}/${ARCHIVE}`;
    if (!lstat(manifestPath)) { unknown(dir, 'legacy raw archive has no hash manifest'); for (const f of files.keys()) if (f.startsWith(`${dir}/`)) unknowns.set(f, 'legacy raw archive is unverified'); continue; }
    try {
      const manifest = JSON.parse(hashFile(manifestPath, limits.maxJsonBytes).data.toString('utf8'));
      if (manifest.version !== 1 || manifest.rawName !== name || typeof manifest.generationFingerprint !== 'string' || !manifest.generationFingerprint || !Array.isArray(manifest.outputs)) throw new Error('invalid archive manifest shape');
      const declarations = [...manifest.outputs, ...(manifest.result ? [manifest.result] : [])];
      const outputHashes = {};
      let resultJsonHash = null;
      for (const item of declarations) {
        if (!item || typeof item.file !== 'string' || item.file.includes('/') || item.file.includes('\\') || !SHA.test(item.sha256) || !Number.isSafeInteger(item.bytes)) throw new Error('invalid archive blob declaration');
        const p = `${dir}/${item.file}`;
        const blob = hashFile(p);
        if (blob.bytes !== item.bytes || blob.sha256 !== item.sha256) { unknown(p, 'archive hash/length mismatch'); throw new Error(`hash mismatch for ${item.file}`); }
        if (item !== manifest.result) {
          if (typeof item.slot !== 'string' || !item.slot || Object.hasOwn(outputHashes, item.slot)) throw new Error('invalid or duplicate archive output slot');
          outputHashes[item.slot] = item.sha256;
        } else {
          try { resultJsonHash = hashJson(JSON.parse(blob.data.toString('utf8'))); }
          catch { throw new Error('invalid inline result JSON'); }
          if (item.jsonHash && item.jsonHash !== resultJsonHash) throw new Error('inline result JSON hash mismatch');
        }
        addRef(p, 'verified-archive', name);
      }
      const rawFingerprint = rawArtifactFingerprint({ generation: manifest.generationFingerprint, outputs: outputHashes, result: resultJsonHash });
      if (manifest.rawFingerprint !== rawFingerprint) throw new Error('archive raw fingerprint mismatch');
      const expected = new Set([ARCHIVE, ...declarations.map((entry) => entry.file)]);
      for (const filename of fs.readdirSync(resolveRoot(root, dir))) if (!expected.has(filename)) unknown(`${dir}/${filename}`, 'unexpected file in raw archive');
      addRef(manifestPath, 'verified-archive-manifest', name);
    } catch (e) {
      unknown(manifestPath, `unverified archive: ${e.message}`);
      for (const f of files.keys()) if (f.startsWith(`${dir}/`)) unknowns.set(f, 'archive manifest or blob verification failed');
    }
  }

  // Journal metadata carries the raw fingerprint; match it only to an archive
  // manifest with that exact fingerprint. Conventional raw id matching is not
  // used because custom raw names are supported.
  if (lstat('run-journal.json')) try {
    const journal = JSON.parse(hashFile('run-journal.json', limits.maxJsonBytes).data.toString('utf8'));
    if (journal.version !== 1 || !journal.jobs || typeof journal.jobs !== 'object') throw new Error('invalid journal shape');
    for (const [id, job] of Object.entries(journal.jobs)) {
      const fp = job?.metadata?.rawFingerprint;
      if (typeof fp !== 'string' || !SHA.test(fp)) continue;
      let matched = false;
      for (const name of fs.readdirSync(resolveRoot(root, 'raw')).sort()) {
        if (used >= limits.maxEntries) { bounded = true; unknown('raw', 'entry limit reached'); break; }
        const p = `raw/${name}/${ARCHIVE}`;
        if (!lstat(p)) continue;
        try {
          const m = JSON.parse(hashFile(p, limits.maxJsonBytes).data.toString('utf8'));
          if (m.rawFingerprint === fp) { addRef(`raw/${name}/${ARCHIVE}`, 'run-journal', id); for (const entry of [...(m.outputs ?? []), ...(m.result ? [m.result] : [])]) addRef(`raw/${name}/${entry.file}`, 'run-journal', id); matched = true; }
        } catch { /* already marked unknown by archive scan */ }
      }
      if (!matched) unknown('raw', `journal job ${id} has an unresolved raw fingerprint`);
    }
  } catch (e) { unknown('run-journal.json', `corrupt journal: ${e.message}`); for (const p of files.keys()) if (p.startsWith('raw/')) unknowns.set(p, 'journal state is corrupt'); }

  const roots = [];
  for (const raw of packRoots) {
    let rel;
    try { resolveRoot(root, raw); rel = raw; } catch (e) { unknown(String(raw), `invalid pack root: ${e.message}`); continue; }
    roots.push(rel); walk(rel);
    const pointer = `${rel}/current.json`, st = lstat(pointer);
    if (!st) {
      unknown(`${rel}/.versions`, 'pack pointer missing; versions cannot be classified');
      for (const file of files.keys()) if (file.startsWith(`${rel}/`)) unknowns.set(file, 'pack root has no supported pointer');
      continue;
    }
    try {
      const d = JSON.parse(hashFile(pointer, limits.maxJsonBytes).data.toString('utf8'));
      if (d.version !== 2 || !ID.test(d.currentVersion) || !(d.previousVersion === null || ID.test(d.previousVersion)) || !d.contentHashes || typeof d.contentHashes !== 'object' || Array.isArray(d.contentHashes)) throw new Error('unsupported or corrupt pack pointer (legacy/unknown)');
      for (const [id, digest] of Object.entries(d.contentHashes)) {
        if (!ID.test(id) || !SHA.test(digest)) throw new Error('invalid pinned version hash');
        const base = `${rel}/.versions/${id}`;
        let actual;
        try { actual = fingerprintTree(base); } catch (e) { unknown(base, `pack version cannot be verified: ${e.message}`); continue; }
        if (actual !== digest) { unknown(base, 'pack version content hash mismatch'); for (const f of files.keys()) if (f.startsWith(`${base}/`)) unknowns.set(f, 'pack version content hash mismatch'); continue; }
        for (const f of files.keys()) if (f.startsWith(`${base}/`)) addRef(f, 'pack-version', id);
        addRef(pointer, 'pack-pointer', `${rel}:${id}`);
      }
      addRef(pointer, 'pack-pointer', rel);
    } catch (e) {
      unknown(pointer, e.message);
      for (const f of files.keys()) if (f.startsWith(`${rel}/.versions/`)) unknowns.set(f, 'pack pointer is corrupt or unsupported');
    }
  }

  function fingerprintTree(base) {
    const directory = resolveRoot(root, base);
    const rootInfo = fs.lstatSync(directory);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('version root is not a real directory');
    const fingerprint = createHash('sha256');
    const walkTree = (dir) => {
      for (const name of fs.readdirSync(dir).sort()) {
        const target = path.join(dir, name), st = fs.lstatSync(target), rel = path.relative(directory, target).split(path.sep).join('/');
        if (st.isSymbolicLink()) throw new Error(`symlink in pack version: ${rel}`);
        if (st.isDirectory()) { fingerprint.update(JSON.stringify(['directory', rel])); walkTree(target); }
        else if (st.isFile()) {
          const relativeToWorkspace = `${base}/${rel}`;
          const body = readBytes(target, st, limits.maxFileBytes);
          fingerprint.update(JSON.stringify(['file', rel, st.size, body.sha256]));
          const item = files.get(relativeToWorkspace);
          if (item) item.sha256 = body.sha256;
        } else throw new Error(`unsupported pack version entry: ${rel}`);
      }
    };
    walkTree(directory);
    return fingerprint.digest('hex');
  }

  // Any file with an untrusted path, failed read, corruption, or incomplete
  // discovery is conservatively unknown. Files explicitly referenced win.
  for (const [p, digests] of expectedHashes) {
    const file = files.get(p);
    if (!file) unknown(p, 'referenced file is missing, unsafe, or unreadable');
    else if ([...digests].some((digest) => digest !== file.sha256)) unknown(p, 'referenced content hash mismatch');
  }
  const graph = [...files.values()].map(({ path: p, bytes, sha256, stat }) => ({
    path: p, bytes, sha256,
    referencedBy: [...(refs.get(p)?.values() ?? [])].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)),
    disposition: unknowns.has(p) || bounded ? 'unknown' : refs.has(p) ? 'referenced' : 'unreferenced',
    reason: unknowns.get(p) ?? (refs.has(p) ? 'referenced by verified local metadata' : bounded ? 'scan was bounded' : 'no reference found in scanned roots'),
  }));
  const rootReports = roots.map((p) => {
    let pointerShape = { state: 'missing', issues: ['pointer is missing'], current: null, previous: null, hasContentHashes: false };
    try {
      const value = JSON.parse(hashFile(`${p}/current.json`, limits.maxJsonBytes).data.toString('utf8'));
      const hasHashes = !!value?.contentHashes && typeof value.contentHashes === 'object' && !Array.isArray(value.contentHashes);
      pointerShape = { state: value?.version === 2 ? 'v2' : value?.version === 1 ? 'v1-shaped' : 'corrupt-or-unsupported', issues: [], current: value?.currentVersion ?? null, previous: value?.previousVersion ?? null, hasContentHashes: hasHashes };
    } catch (e) { pointerShape = { state: 'unknown', issues: [e.message], current: null, previous: null, hasContentHashes: false }; }
    return { path: p, pointerShape };
  });
  return { version: GC_REPORT_VERSION, generatedAt: started, roots: rootReports, entries: graph, totals: {
    files: graph.length, bytes: graph.reduce((n, e) => n + e.bytes, 0), referenced: graph.filter((e) => e.disposition === 'referenced').length,
    unreferenced: graph.filter((e) => e.disposition === 'unreferenced').length, unknown: graph.filter((e) => e.disposition === 'unknown').length,
  }, canDelete: false, warnings, bounded };
}

/** Render a report independently from collection, without filesystem writes. */
export function buildGarbageReport(options = {}) {
  const graph = collectReferences(options);
  return { version: graph.version, generatedAt: graph.generatedAt, roots: graph.roots, entries: graph.entries,
    totals: graph.totals, canDelete: false, warnings: graph.warnings, bounded: graph.bounded };
}

// Kept for compatibility with early experimental callers.
export const reportGcReferences = buildGarbageReport;
