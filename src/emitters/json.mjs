// `json` emitter: one aggregate JSON bundle for the whole run.
//
//   { version, generator, provenance, <buckets...> }
//
// Options: { file?, pretty?, provenance?, shape? } where shape is `buckets`
// (default) or `records` for the flat portable-record list.

import fs from 'node:fs';
import path from 'node:path';
import { bundleRecords } from '../bundle.mjs';

export const name = 'json';

export function emit(records, ctx) {
  const { outDir, options = {}, provenance = {}, version = 1, generator = 'mothbake' } = ctx;
  const target = path.join(outDir, options.file ?? 'mothbake.json');
  const data =
    options.shape === 'records'
      ? records
      : bundleRecords(records, { version, generator, provenance: options.provenance === false ? {} : provenance });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(data, null, options.pretty ?? 2)}\n`);
  return [target];
}
