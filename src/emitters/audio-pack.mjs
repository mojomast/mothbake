// `audio-pack` emitter: write a self-contained audio bundle plus a manifest.
//
//   <outDir>/<dir>/<bucket>/<key>.wav     audio-clip / audio-stitch (decoded or
//                                         copied from `file`), and `ir` audio
//   <outDir>/<dir>/<bucket>/<key>.json    echo-map / ir descriptor sidecar
//   <outDir>/<dir>/manifest.json          { version, generator, provenance,
//                                         clips, spaces, irs }
//
// Every clip entry carries `url`, `seconds`, `sampleRate`, `channels`,
// `loopStart`, `loopEnd` and `gain`, so a consumer can fetch and loop it
// without reading the raw record. Output is deterministic (records are written
// in order, base64 is decoded verbatim) and idempotent.
//
// Options: `dir`, `manifest` (filename, default `manifest.json`, or `false`),
// `pretty` (default 2), `sidecar` (default true; write echo-map/ir JSON),
// `merge` (default false; merge this run's entries over the previous manifest).
// Every file is written atomically and the manifest is validated as exact JSON.

import fs from 'node:fs';
import path from 'node:path';
import { fromBase64 } from '../image.mjs';
import { assertJsonSafe, mergeBundles, readJsonArtifact, validateForPublish, writeFileAtomic } from '../publish.mjs';

export const name = 'audio-pack';

const posix = (value) => value.split(path.sep).join('/');

function write(root, relative, data, written) {
  const target = path.join(root, relative);
  writeFileAtomic(target, data);
  written.push(target);
  return target;
}

function clipDescriptor(record, value, file, url) {
  const descriptor = {
    bucket: record.bucket,
    key: record.key,
    type: record.type,
    file,
    url,
    seconds: value.seconds ?? null,
    sampleRate: value.sampleRate ?? null,
    channels: value.channels ?? null,
    loopStart: value.loopStart ?? null,
    loopEnd: value.loopEnd ?? null,
    gain: value.gain ?? null,
  };
  if (value.meta !== undefined) descriptor.meta = value.meta;
  return descriptor;
}

export function emit(records, ctx) {
  const { outDir, options = {}, provenance = {}, version = 1, generator = 'mothbake' } = ctx;
  const root = path.join(outDir, options.dir ?? '');
  const pretty = options.pretty ?? 2;
  const written = [];
  const clips = {};
  const spaces = {};
  const irs = {};

  for (const record of records) {
    const value = record.value ?? {};
    if (record.type === 'audio-clip' || record.type === 'audio-stitch') {
      let buffer;
      if (typeof value.data === 'string' && value.container === 'wav') {
        buffer = fromBase64(value.data);
      } else if (typeof value.file === 'string') {
        const source = path.resolve(outDir, value.file);
        if (!fs.existsSync(source)) throw new Error(`audio-pack: ${record.type} "${record.key}" file not found: ${value.file}`);
        buffer = fs.readFileSync(source);
      } else {
        throw new Error(`audio-pack: ${record.type} "${record.key}" has neither data nor file`);
      }
      const relative = path.join(record.bucket, `${record.key}.wav`);
      const target = write(root, relative, buffer, written);
      const packRelative = posix(path.relative(root, target));
      clips[`${record.bucket}/${record.key}`] = clipDescriptor(record, value, packRelative, value.url ?? packRelative);
      continue;
    }
    if (record.type === 'ir') {
      let packRelative = null;
      if (typeof value.file === 'string') {
        const source = path.resolve(outDir, value.file);
        if (fs.existsSync(source)) {
          const relative = path.join(record.bucket, `${record.key}${path.extname(source) || '.wav'}`);
          const target = write(root, relative, fs.readFileSync(source), written);
          packRelative = posix(path.relative(root, target));
        }
      }
      irs[`${record.bucket}/${record.key}`] = {
        bucket: record.bucket,
        key: record.key,
        type: record.type,
        file: packRelative,
        url: value.url ?? packRelative,
        seconds: value.seconds ?? null,
        sampleRate: value.sampleRate ?? null,
        channels: value.channels ?? null,
        format: value.format ?? null,
        taps: Array.isArray(value.taps) ? value.taps.length : 0,
      };
      if (options.sidecar !== false) {
        const sidecar = { ...value, file: packRelative ?? value.file ?? null };
        assertJsonSafe(sidecar, `audio-pack emitter (${record.bucket}.${record.key})`);
        write(root, path.join(record.bucket, `${record.key}.json`), `${JSON.stringify(sidecar, null, pretty)}\n`, written);
      }
      continue;
    }
    if (record.type === 'echo-map') {
      spaces[`${record.bucket}/${record.key}`] = value;
      if (options.sidecar !== false) {
        assertJsonSafe(value, `audio-pack emitter (${record.bucket}.${record.key})`);
        write(root, path.join(record.bucket, `${record.key}.json`), `${JSON.stringify(value, null, pretty)}\n`, written);
      }
      continue;
    }
  }

  if (options.manifest !== false) {
    const manifestName = options.manifest ?? 'manifest.json';
    const target = path.join(root, manifestName);
    const label = `audio-pack emitter (${manifestName})`;
    const fresh = { version, generator, provenance, clips, spaces, irs };
    const previous = options.merge ? readJsonArtifact(target, label) : null;
    const manifest = options.merge ? mergeBundles(previous, fresh) : fresh;
    validateForPublish(manifest, { expectedProvenance: Object.keys(provenance), label });
    write(root, manifestName, `${JSON.stringify(manifest, null, pretty)}\n`, written);
  }
  return written;
}

export default emit;
