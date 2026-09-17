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
// Options: { dir?, index? }.

import fs from 'node:fs';
import path from 'node:path';
import { encodePng } from '../decoders/png.mjs';
import { fromBase64 } from '../image.mjs';

export const name = 'files';

const posix = (value) => value.split(path.sep).join('/');

function write(root, relative, data, written) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
  written.push(target);
  return target;
}

function isImageValue(value) {
  return Boolean(value) && typeof value.data === 'string' && Number.isInteger(value.width) && Number.isInteger(value.height);
}

export function emit(records, ctx) {
  const { outDir, options = {}, provenance = {}, version = 1, generator = 'mothbake' } = ctx;
  const root = path.join(outDir, options.dir ?? '');
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
    // Structured records (and IR descriptors) are written as JSON. An IR also
    // copies its audio file so the bundle is self-contained.
    const jsonRelative = path.join(record.bucket, `${record.key}.json`);
    const jsonTarget = write(root, jsonRelative, `${JSON.stringify(value, null, 2)}\n`, written);
    index.push({ bucket: record.bucket, key: record.key, job: record.job, type: record.type, file: posix(path.relative(outDir, jsonTarget)), bytes: fs.statSync(jsonTarget).size });
    if (record.type === 'ir' && typeof value.file === 'string') {
      const source = path.resolve(outDir, value.file);
      if (fs.existsSync(source)) {
        const extension = path.extname(source) || '.wav';
        const audioRelative = path.join(record.bucket, `${record.key}${extension}`);
        const audioTarget = write(root, audioRelative, fs.readFileSync(source), written);
        index.push({ bucket: record.bucket, key: record.key, job: record.job, type: record.type, file: posix(path.relative(outDir, audioTarget)), bytes: fs.statSync(audioTarget).size });
      }
    }
  }

  if (options.index !== false) {
    const indexFile = path.join(outDir, options.indexFile ?? 'index.json');
    fs.mkdirSync(path.dirname(indexFile), { recursive: true });
    fs.writeFileSync(indexFile, `${JSON.stringify({ version, generator, provenance, files: index }, null, 2)}\n`);
    written.push(indexFile);
  }
  return written;
}
