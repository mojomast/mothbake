// `files` emitter: write each portable record as a decoded file under the
// output directory.
//
//   <outDir>/textures/rock.png          base64 RGBA/RGB payloads become PNGs
//   <outDir>/materials/lut.r.png        LUT swatches split into two PNGs
//   <outDir>/effects/rift.000.png       frames numbered in playback order
//   <outDir>/levels/arena.json          structured records become JSON
//   <outDir>/irs/cavern.wav             IR audio is copied, descriptor alongside
//   <outDir>/index.json                 manifest of everything written
//
// Options: { dir?, index?, indexFile?, merge? }.
//
// Every file is written atomically, and structured record values are validated
// as exact JSON before they land. `merge: true` merges the previous index.json
// (entries keyed by file path, provenance unioned) so a partial run keeps the
// manifest of everything already on disk; the files themselves are never
// deleted either way.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { encodePng } from '../decoders/png.mjs';
import { fromBase64 } from '../image.mjs';
import { assertJsonSafe, mergeIndex, readJsonArtifact, validateForPublish, writeFileAtomic } from '../publish.mjs';

export const name = 'files';

const posix = (value) => value.split(path.sep).join('/');

/** Confine emitter destinations, including already existing symlink components. */
export function assertDestinationPath(relative, label, { directory = false } = {}) {
  if (directory && relative === '') return;
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || path.isAbsolute(relative)
    || /^[a-zA-Z]:/.test(relative) || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`${label}: invalid destination path: ${relative}`);
  }
}

export function destination(outDir, relative, label, { directory = false } = {}) {
  assertDestinationPath(relative, label, { directory });
  const base = path.resolve(outDir);
  const target = path.resolve(base, relative);
  const tail = path.relative(base, target);
  if (tail === '..' || tail.startsWith(`..${path.sep}`) || path.isAbsolute(tail)) throw new Error(`${label}: destination escapes outDir: ${relative}`);
  const ancestors = [];
  for (let component = base; component !== path.dirname(component); component = path.dirname(component)) ancestors.unshift(component);
  for (const component of [...ancestors, ...tail.split(path.sep).filter(Boolean).map((_, i, parts) => path.join(base, ...parts.slice(0, i + 1)))]) {
    let stat;
    try { stat = fs.lstatSync(component); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`${label}: symlink destination: ${component}`);
    if (component !== target && !stat.isDirectory()) throw new Error(`${label}: destination component is not a directory: ${component}`);
    if (component === target && directory && !stat.isDirectory()) throw new Error(`${label}: destination is not a directory: ${component}`);
    if (component === target && !directory && !stat.isFile()) throw new Error(`${label}: destination is not a regular file: ${component}`);
  }
  return target;
}

export function recordDestination(root, record, extension, label) {
  destination(root, record.bucket, label, { directory: true });
  if (typeof record.key !== 'string' || !record.key || record.key.includes('/') || record.key.includes('\\')
    || record.key === '.' || record.key === '..' || /^[a-zA-Z]:/.test(record.key)) {
    throw new Error(`${label}: invalid record key: ${record.key}`);
  }
  return destination(root, `${record.bucket}/${record.key}${extension}`, label);
}

/** Resolve an external baked artifact without following a reference outside outDir. */
export function readExternalAudio(outDir, record, value) {
  const label = `${record.type} "${record.key}"`;
  const file = value.file;
  if (typeof file !== 'string' || !file || path.isAbsolute(file) || /^[a-zA-Z]:/.test(file)
    || file.includes('\\') || file.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error(`${label}: invalid external file reference: ${file}`);
  }
  if ((record.type === 'audio-clip' || record.type === 'audio-stitch') && file.split('/')[0].toLowerCase() === 'raw') {
    throw new Error(`${label}: raw audio reference is not a processed WAV: ${file}`);
  }
  const source = path.resolve(outDir, file);
  const within = (root, target) => {
    const relative = path.relative(root, target);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  if (!within(path.resolve(outDir), source)) throw new Error(`${label}: external file escapes outDir: ${file}`);
  let realRoot;
  let realSource;
  try {
    realRoot = fs.realpathSync(outDir);
    realSource = fs.realpathSync(source);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${label}: file not found: ${file}`);
    throw error;
  }
  if (!within(realRoot, realSource)) throw new Error(`${label}: external file escapes outDir: ${file}`);
  if ((record.type === 'audio-clip' || record.type === 'audio-stitch')
    && path.relative(realRoot, realSource).split(path.sep)[0].toLowerCase() === 'raw') {
    throw new Error(`${label}: raw audio reference is not a processed WAV: ${file}`);
  }
  if (!fs.statSync(source).isFile()) throw new Error(`${label}: external file is not a regular file: ${file}`);
  const buffer = fs.readFileSync(source);
  if (value.bytes !== undefined && buffer.length !== value.bytes) {
    throw new Error(`${label}: byte length mismatch for ${file}`);
  }
  if (value.sha256 !== undefined && createHash('sha256').update(buffer).digest('hex') !== value.sha256) {
    throw new Error(`${label}: sha256 mismatch for ${file}`);
  }
  return { source, buffer };
}

function writeExternalAudio(root, relative, outDir, record, value, written) {
  const { source, buffer } = readExternalAudio(outDir, record, value);
  const target = path.resolve(root, relative);
  if (target === source || (fs.existsSync(target) && fs.realpathSync(target) === fs.realpathSync(source))) {
    throw new Error(`${record.type} "${record.key}": output would overwrite source file: ${value.file}`);
  }
  return write(root, relative, buffer, written);
}

function write(root, relative, data, written) {
  const target = destination(root, relative, 'files emitter');
  writeFileAtomic(target, data);
  written.push(target);
  return target;
}

function isImageValue(value) {
  return Boolean(value) && typeof value.data === 'string' && Number.isInteger(value.width) && Number.isInteger(value.height);
}

function isSheetValue(value) {
  return Boolean(value) && value.sheet && typeof value.sheet.data === 'string'
    && Number.isInteger(value.sheet.width) && Number.isInteger(value.sheet.height);
}

function isAudioValue(value) {
  return Boolean(value) && typeof value.data === 'string' && value.container === 'wav';
}

export function emit(records, ctx) {
  const { outDir, options = {}, provenance = {}, version = 1, generator = 'mothbake' } = ctx;
  const root = destination(outDir, options.dir ?? '', 'files emitter dir', { directory: true });
  const indexFile = options.index === false ? null : destination(outDir, options.indexFile ?? 'index.json', 'files emitter index');
  for (const record of records) {
    recordDestination(root, record, '.json', 'files emitter record');
    for (const ext of ['.png', '.wav', '.r.png', '.t.png', '.reflectance.hdr', '.transmittance.hdr']) recordDestination(root, record, ext, 'files emitter record');
  }
  const written = [];
  const index = [];

  for (const record of records) {
    const value = record.value ?? {};
    if (record.type === 'material-lut' && typeof value.r === 'string' && typeof value.t === 'string') {
      const size = value.size;
      for (const [channel, data] of [['r', value.r], ['t', value.t]]) {
        const relative = path.join(record.bucket, `${record.key}.${channel}.png`);
        const target = write(root, relative, encodePng(size, size, fromBase64(data), { alpha: false }), written);
        index.push({ bucket: record.bucket, key: record.key, job: record.job, type: record.type, channel, file: posix(path.relative(outDir, target)), bytes: fs.statSync(target).size });
      }
      const descriptor = { ...value };
      if (value.masters && typeof value.masters === 'object') {
        descriptor.masters = {};
        for (const role of ['reflectance', 'transmittance']) {
          const master = value.masters[role];
          if (!master || typeof master.data !== 'string') throw new Error(`files emitter: material-lut missing ${role} HDR master`);
          const bytes = fromBase64(master.data);
          if (master.bytes !== bytes.length || createHash('sha256').update(bytes).digest('hex') !== master.sha256) throw new Error(`files emitter: material-lut ${role} master hash mismatch`);
          const relative = path.join(record.bucket, `${record.key}.${role}.hdr`);
          const target = write(root, relative, bytes, written);
          index.push({ bucket: record.bucket, key: record.key, job: record.job, type: record.type, channel: `${role}-master`, file: posix(path.relative(outDir, target)), bytes: bytes.length });
          descriptor.masters[role] = { ...master, data: undefined, file: posix(path.relative(root, target)) };
          delete descriptor.masters[role].data;
        }
        assertJsonSafe(descriptor, `files emitter (${record.bucket}.${record.key})`);
        const relative = path.join(record.bucket, `${record.key}.json`);
        const target = write(root, relative, `${JSON.stringify(descriptor, null, 2)}\n`, written);
        index.push({ bucket: record.bucket, key: record.key, job: record.job, type: record.type, channel: 'descriptor', file: posix(path.relative(outDir, target)), bytes: fs.statSync(target).size });
      }
      continue;
    }
    if (isImageValue(value)) {
      const suffix = record.merge === 'frames' ? `.${String(record.index ?? 0).padStart(3, '0')}` : '';
      const relative = path.join(record.bucket, `${record.key}${suffix}.png`);
      const alpha = value.format !== 'rgb8';
      const target = write(root, relative, encodePng(value.width, value.height, fromBase64(value.data), { alpha }), written);
      index.push({ bucket: record.bucket, key: record.key, job: record.job, type: record.type, file: posix(path.relative(outDir, target)), bytes: fs.statSync(target).size });
      continue;
    }
    // A sprite-sheet record carries its packed atlas under `value.sheet`.
    if (isSheetValue(value)) {
      const relative = path.join(record.bucket, `${record.key}.png`);
      const target = write(root, relative, encodePng(value.sheet.width, value.sheet.height, fromBase64(value.sheet.data), { alpha: true }), written);
      index.push({ bucket: record.bucket, key: record.key, job: record.job, type: record.type, file: posix(path.relative(outDir, target)), bytes: fs.statSync(target).size });
      continue;
    }
    // Audio records carry either a complete WAV or a processed external WAV.
    if (isAudioValue(value)) {
      const relative = path.join(record.bucket, `${record.key}.wav`);
      const target = write(root, relative, Buffer.from(value.data, 'base64'), written);
      index.push({ bucket: record.bucket, key: record.key, job: record.job, type: record.type, file: posix(path.relative(outDir, target)), bytes: fs.statSync(target).size });
      continue;
    }
    if ((record.type === 'audio-clip' || record.type === 'audio-stitch') && typeof value.file === 'string') {
      const relative = path.join(record.bucket, `${record.key}.wav`);
      const target = writeExternalAudio(root, relative, outDir, record, value, written);
      index.push({ bucket: record.bucket, key: record.key, job: record.job, type: record.type, file: posix(path.relative(outDir, target)), bytes: fs.statSync(target).size });
      continue;
    }
    if ((record.type === 'audio-clip' || record.type === 'audio-stitch') && !isAudioValue(value)) {
      throw new Error(`${record.type} "${record.key}" has neither data nor file`);
    }
    // Structured records (and IR descriptors) are written as JSON. An IR also
    // copies its audio file so the bundle is self-contained.
    if (record.type === 'ir' && typeof value.file === 'string') readExternalAudio(outDir, record, value);
    assertJsonSafe(value, `files emitter (${record.bucket}.${record.key})`);
    const jsonRelative = path.join(record.bucket, `${record.key}.json`);
    const jsonTarget = write(root, jsonRelative, `${JSON.stringify(value, null, 2)}\n`, written);
    index.push({ bucket: record.bucket, key: record.key, job: record.job, type: record.type, file: posix(path.relative(outDir, jsonTarget)), bytes: fs.statSync(jsonTarget).size });
    if (record.type === 'ir' && typeof value.file === 'string') {
      const extension = path.extname(value.file) || '.wav';
      const audioRelative = path.join(record.bucket, `${record.key}${extension}`);
      const audioTarget = writeExternalAudio(root, audioRelative, outDir, record, value, written);
      index.push({ bucket: record.bucket, key: record.key, job: record.job, type: record.type, file: posix(path.relative(outDir, audioTarget)), bytes: fs.statSync(audioTarget).size });
    }
  }

  if (options.index !== false) {
    const indexName = options.indexFile ?? 'index.json';
    const label = `files emitter (${indexName})`;
    const fresh = { version, generator, provenance, files: index };
    const previous = options.merge ? readJsonArtifact(indexFile, label) : null;
    const data = options.merge ? mergeIndex(previous, fresh) : fresh;
    validateForPublish(data, { expectedProvenance: Object.keys(provenance), label });
    writeFileAtomic(indexFile, `${JSON.stringify(data, null, 2)}\n`);
    written.push(indexFile);
  }
  return written;
}
