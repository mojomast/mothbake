// Immutable raw-result archives. Signed URLs are transport only and are never
// persisted. New archives carry exact slot/content hashes and generation
// identity; legacy raw directories remain readable but explicitly unverified.

import fs from 'node:fs';
import path from 'node:path';
import { hashBytes, hashJson, rawArtifactFingerprint } from './identity.mjs';
import { bakeSpecs } from './bakers/specs.mjs';

export const ARCHIVE_VERSION = 1;
export const ARCHIVE_MANIFEST = '.mothbake-archive.json';

const CONTENT_TYPE_EXTENSIONS = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/vnd.radiance': 'hdr', 'application/zip': 'zip', 'application/json': 'json',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/midi': 'mid', 'audio/mpeg': 'mp3',
  'application/octet-stream': 'bin',
};

export const sanitizeSlot = (name) => String(name).replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();

function extensionFor(contentType, source) {
  if (contentType && CONTENT_TYPE_EXTENSIONS[contentType]) return CONTENT_TYPE_EXTENSIONS[contentType];
  const pathname = (() => {
    try { return new URL(source, 'https://example.invalid').pathname; } catch { return String(source ?? ''); }
  })();
  const extension = path.extname(pathname).replace(/^\./, '');
  return extension && /^[a-z0-9]{1,8}$/i.test(extension) ? extension : 'bin';
}

function confined(root, relative, label) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.includes('\\')) {
    throw new Error(`${label}: invalid archive path`);
  }
  const target = path.resolve(root, relative);
  const rel = path.relative(path.resolve(root), target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`${label}: archive path escapes raw directory`);
  return target;
}

function parseManifest(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error('archive manifest is not a regular file');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`archive manifest is corrupt: ${error.message}`); }
  if (!manifest || manifest.version !== ARCHIVE_VERSION || typeof manifest.rawName !== 'string'
    || typeof manifest.recipeFingerprint !== 'string' || typeof manifest.generationFingerprint !== 'string'
    || !Array.isArray(manifest.outputs) || (manifest.result !== null && typeof manifest.result !== 'object')) {
    throw new Error('archive manifest has an unsupported version or shape');
  }
  return manifest;
}

function verifyBlob(rawDir, entry, label, expectedFile = null) {
  if (!entry || typeof entry.file !== 'string' || typeof entry.sha256 !== 'string' || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
    throw new Error(`${label}: invalid archive entry`);
  }
  const file = confined(rawDir, entry.file, label);
  if (path.basename(file) !== entry.file || (expectedFile ? entry.file !== expectedFile : [ARCHIVE_MANIFEST, 'inline-result.json'].includes(entry.file))) throw new Error(`${label}: invalid archive filename`);
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { throw new Error(`${label}: archived blob missing: ${entry.file}`, { cause: error }); }
  if (!stat.isFile()) throw new Error(`${label}: archived blob is not a file: ${entry.file}`);
  const bytes = fs.readFileSync(file);
  if (bytes.length !== entry.bytes) throw new Error(`${label}: byte length mismatch: ${entry.file}`);
  if (hashBytes(bytes) !== entry.sha256) throw new Error(`${label}: sha256 mismatch: ${entry.file}`);
  return { file, bytes };
}

/** Save a response and a hash-verified archive manifest. */
export async function archiveResponse(options = {}) {
  const { response, api, outDir, rawName, recipeFingerprint, generationFingerprint, jobId = null, engine, verification = 'journal-verified', signal, log = () => {} } = options;
  const rawDir = path.join(outDir, 'raw', rawName);
  confined(path.join(outDir, 'raw'), rawName, 'raw name');
  if (fs.existsSync(rawDir) && !fs.lstatSync(rawDir).isDirectory()) throw new Error(`raw/${rawName}: archive path is not a directory`);
  const existingManifest = path.join(rawDir, ARCHIVE_MANIFEST);
  if (fs.existsSync(rawDir) && !fs.existsSync(existingManifest)) {
    throw new Error(`raw/${rawName} already exists without a verified manifest; refusing to overwrite raw evidence`);
  }
  const files = new Map();
  const saved = new Map();
  const outputs = [];
  const staged = new Map();
  const names = new Set([ARCHIVE_MANIFEST, 'inline-result.json']);
  const sources = response.files
    ? [...response.files].map(([slot, buffer]) => ({ slot, buffer, source: response.sources?.get(slot) ?? slot, recorded: true }))
    : (response.outputs ?? []).map((output, index) => ({
      slot: output.slot || `output-${index}`, output, source: output.filename ?? output.url,
      contentType: output.content_type ?? null, assetId: output.output_asset_id ?? null,
    }));

  // Check every filename before fetching or writing any output. Slot names may
  // differ while sanitizing to the same name (including reserved archive names).
  for (const item of sources) {
    if (typeof item.slot !== 'string' || !item.slot || !sanitizeSlot(item.slot)) throw new Error(`invalid archive output slot: ${item.slot}`);
    const name = `${sanitizeSlot(item.slot)}.${extensionFor(item.contentType ?? null, item.source ?? item.slot)}`;
    if (files.has(item.slot) || names.has(name)) throw new Error(`raw/${rawName}: archive filename collision: ${name}`);
    names.add(name);
    files.set(item.slot, null);
    item.name = name;
  }
  files.clear();

  const put = (item, buffer) => {
    const { slot, name } = item;
    if (!(buffer instanceof Uint8Array)) throw new TypeError(`raw/${rawName}/${slot}: output must contain bytes`);
    const target = path.join(rawDir, name);
    const relative = path.join('raw', rawName, name);
    files.set(slot, buffer);
    saved.set(slot, { file: target, relative, contentType: item.contentType ?? null, assetId: item.assetId ?? null });
    outputs.push({ slot, file: name, contentType: item.contentType ?? null, assetId: item.assetId ?? null, bytes: buffer.length, sha256: hashBytes(buffer) });
    staged.set(name, buffer);
  };

  for (const item of sources) {
    if (item.recorded) {
      put(item, item.buffer);
    } else {
      const output = item.output;
      let buffer = output.bufferOverride;
      if (!buffer) {
        if (!output.url && output.output_asset_id) {
          buffer = await api.refreshOutputAsset(output.output_asset_id, { contentType: output.content_type, signal });
        } else {
          try {
            buffer = await api.downloadOutput(output.url, { contentType: output.content_type, signal });
          } catch (error) {
            if (!output.output_asset_id || ![401, 403, 404].includes(error?.status)) throw error;
            buffer = await api.refreshOutputAsset(output.output_asset_id, { contentType: output.content_type, signal });
            log(`  refreshed expired output URL for slot ${output.slot ?? '(unnamed)'}`);
          }
        }
      }
      put(item, buffer);
    }
  }

  let resultEntry = null;
  if (response.result !== undefined && response.result !== null) {
    const bytes = Buffer.from(`${JSON.stringify(response.result, null, 2)}\n`);
    const name = 'inline-result.json';
    staged.set(name, bytes);
    resultEntry = { file: name, bytes: bytes.length, sha256: hashBytes(bytes), jsonHash: hashJson(response.result) };
  }
  outputs.sort((a, b) => a.slot.localeCompare(b.slot));
  const rawFingerprint = rawArtifactFingerprint({
    generation: generationFingerprint,
    outputs: Object.fromEntries(outputs.map((entry) => [entry.slot, entry.sha256])),
    result: resultEntry?.jsonHash ?? null,
  });
  const manifest = {
    version: ARCHIVE_VERSION,
    rawName,
    engine,
    jobId,
    recipeFingerprint,
    generationFingerprint,
    verification,
    rawFingerprint,
    outputs,
    result: resultEntry,
  };
  if (fs.existsSync(rawDir)) {
    const existing = readArchive({ outDir, rawName, requireVerified: true });
    if (JSON.stringify(existing.manifest) !== JSON.stringify(manifest)) {
      throw new Error(`raw/${rawName} already contains different archive evidence; refusing to overwrite immutable raw evidence`);
    }
    return existing;
  }
  staged.set(ARCHIVE_MANIFEST, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  fs.mkdirSync(path.dirname(rawDir), { recursive: true });
  const temporary = fs.mkdtempSync(path.join(path.dirname(rawDir), '.mothbake-archive-'));
  try {
    for (const [name, bytes] of staged) fs.writeFileSync(path.join(temporary, name), bytes, { flag: 'wx' });
    if (fs.existsSync(rawDir)) throw new Error(`raw/${rawName} appeared during archive staging; refusing to overwrite raw evidence`);
    fs.renameSync(temporary, rawDir);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true });
  }
  for (const entry of outputs) log(`  ${response.files ? 'fixture' : 'saved'} ${path.join('raw', rawName, entry.file)} (${entry.bytes} bytes)`);
  return { files, saved, result: response.result ?? null, rawDir, manifest, rawFingerprint, verified: true };
}

function declaredSlots(job) {
  const slots = new Set(['result']);
  for (const bake of bakeSpecs(job)) {
    for (const key of ['slot', 'tapsSlot', 'irSlot']) if (typeof bake[key] === 'string' && bake[key]) slots.add(bake[key]);
    for (const entry of bake.slots ?? bake.order ?? []) {
      if (typeof entry === 'string' && entry) slots.add(entry);
      else if (entry && typeof entry.slot === 'string' && entry.slot) slots.add(entry.slot);
    }
  }
  return slots;
}

function readLegacy(rawDir, rawName, outDir, job) {
  const files = new Map();
  const saved = new Map();
  let result = null;
  const bySanitized = new Map([...declaredSlots(job)].map((slot) => [sanitizeSlot(slot), slot]));
  for (const name of fs.readdirSync(rawDir).sort()) {
    if (name === ARCHIVE_MANIFEST || name === 'inline-result.json') continue;
    const file = path.join(rawDir, name);
    const stat = fs.statSync(file);
    if (!stat.isFile()) continue;
    if (name === 'result.json') {
      try { result = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { result = null; }
      continue;
    }
    const extension = path.extname(name);
    const stem = extension ? name.slice(0, -extension.length) : name;
    const slot = bySanitized.get(stem) ?? stem;
    files.set(slot, fs.readFileSync(file));
    saved.set(slot, { file, relative: path.relative(outDir, file), contentType: null, assetId: null });
  }
  return { files, saved, result, rawDir, manifest: null, rawFingerprint: null, verified: false, rawName };
}

/** Read and verify a new archive, or explicitly return an unverified legacy archive. */
export function readArchive({ outDir, rawName, rawDir: explicitRawDir = null, job = {}, requireVerified = false }) {
  if (!explicitRawDir) confined(path.join(outDir, 'raw'), rawName, 'raw name');
  const rawDir = explicitRawDir ?? path.join(outDir, 'raw', rawName);
  if (!fs.existsSync(rawDir)) throw new Error(`no raw outputs at ${path.relative(outDir, rawDir) || rawDir}; nothing to rebuild`);
  if (!fs.lstatSync(rawDir).isDirectory()) throw new Error(`raw/${rawName}: archive path is not a directory`);
  const manifestFile = path.join(rawDir, ARCHIVE_MANIFEST);
  if (!fs.existsSync(manifestFile)) {
    if (requireVerified) throw new Error(`raw/${rawName}: legacy archive has no ${ARCHIVE_MANIFEST}; provenance is unverified`);
    return readLegacy(rawDir, rawName, outDir, job);
  }
  const manifest = parseManifest(manifestFile);
  if (manifest.rawName !== rawName) throw new Error(`raw/${rawName}: archive rawName mismatch`);
  const files = new Map();
  const saved = new Map();
  const outputHashes = {};
  const names = new Set([ARCHIVE_MANIFEST, 'inline-result.json']);
  for (const entry of manifest.outputs) {
    if (typeof entry.slot !== 'string' || !entry.slot) throw new Error(`raw/${rawName}: invalid output slot`);
    if (files.has(entry.slot) || names.has(entry.file)) throw new Error(`raw/${rawName}: duplicate archive output slot or filename`);
    names.add(entry.file);
    const { file, bytes } = verifyBlob(rawDir, entry, `raw/${rawName}/${entry.slot}`);
    files.set(entry.slot, bytes);
    saved.set(entry.slot, { file, relative: path.relative(outDir, file), contentType: entry.contentType ?? null, assetId: entry.assetId ?? null });
    outputHashes[entry.slot] = entry.sha256;
  }
  let result = null;
  let resultHash = null;
  if (manifest.result) {
    const { bytes } = verifyBlob(rawDir, manifest.result, `raw/${rawName}/result`, 'inline-result.json');
    try { result = JSON.parse(bytes.toString('utf8')); } catch (error) { throw new Error(`raw/${rawName}: inline result is not valid JSON: ${error.message}`); }
    resultHash = hashJson(result);
    if (manifest.result.jsonHash && resultHash !== manifest.result.jsonHash) throw new Error(`raw/${rawName}: inline result JSON hash mismatch`);
  }
  const rawFingerprint = rawArtifactFingerprint({ generation: manifest.generationFingerprint, outputs: outputHashes, result: resultHash });
  if (rawFingerprint !== manifest.rawFingerprint) throw new Error(`raw/${rawName}: raw fingerprint mismatch`);
  const expectedFiles = new Set([...names]);
  if (!manifest.result) expectedFiles.delete('inline-result.json');
  for (const name of fs.readdirSync(rawDir)) {
    if (!expectedFiles.has(name)) throw new Error(`raw/${rawName}: unexpected archived file: ${name}`);
  }
  return { files, saved, result, rawDir, manifest, rawFingerprint, verified: true, rawName };
}
