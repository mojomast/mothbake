// `atlas` emitter: write every sprite-sheet record as a PNG atlas plus a JSON
// sidecar with the animation metadata.
//
//   <outDir>/<bucket>/<key>.png    the packed RGBA sheet
//   <outDir>/<bucket>/<key>.json   { width, height, sheet, frames, loops, fps }
//
// Options: { dir?, sidecar? } where `dir` prefixes a subdirectory and
// `sidecar: false` skips the JSON. Output is deterministic (records are
// processed in order, PNG encoding is fixed, sidecars use a stable key order)
// and idempotent (a re-run rewrites identical bytes).

import fs from 'node:fs';
import path from 'node:path';
import { encodePng } from '../decoders/png.mjs';
import { fromBase64 } from '../image.mjs';

export const name = 'atlas';

const posix = (value) => value.split(path.sep).join('/');

function write(root, relative, data, written) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
  written.push(target);
  return target;
}

function sidecarFor(record, sheetPath) {
  const { sheet, frames = [], loops = null, fps, source } = record.value;
  return {
    key: record.key,
    width: sheet.width,
    height: sheet.height,
    format: sheet.format ?? 'rgba8',
    sheet: sheetPath,
    frames: frames.map((frame) => ({
      index: frame.index,
      x: frame.x,
      y: frame.y,
      w: frame.w,
      h: frame.h,
      delay: frame.delay,
      delayCs: frame.delayCs,
      duplicate: Boolean(frame.duplicate),
    })),
    loops,
    ...(fps === undefined ? {} : { fps }),
    ...(source === undefined ? {} : { source }),
  };
}

export function emit(records, ctx) {
  const { outDir, options = {} } = ctx;
  const root = path.join(outDir, options.dir ?? '');
  const written = [];

  for (const record of records) {
    const value = record.value;
    if (record.type !== 'sprite-sheet' || !value?.sheet || typeof value.sheet.data !== 'string') continue;
    const sheet = value.sheet;
    const pngRelative = path.join(record.bucket, `${record.key}.png`);
    const target = write(root, pngRelative, encodePng(sheet.width, sheet.height, fromBase64(sheet.data), { alpha: true }), written);
    if (options.sidecar === false) continue;
    const jsonRelative = path.join(record.bucket, `${record.key}.json`);
    const sidecar = sidecarFor(record, posix(path.relative(outDir, target)));
    write(root, jsonRelative, `${JSON.stringify(sidecar, null, options.pretty ?? 2)}\n`, written);
  }
  return written;
}

export default emit;
