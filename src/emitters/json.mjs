// `json` emitter: one aggregate JSON bundle for the whole run.
//
//   { version, generator, provenance, <buckets...> }
//
// Options: { file?, pretty?, provenance?, shape?, merge? } where shape is
// `buckets` (default) or `records` for the flat portable-record list.
//
// With `merge: true` the previous file is loaded and this run's records are
// merged over it (see `src/publish.mjs`), so a partial run — `--only`,
// disabled jobs or job failures — keeps everything a previous run published.
// Without it the file is replaced exactly as before. Either way the write is
// atomic and the aggregate is validated as exact JSON before it lands.

import path from 'node:path';
import { bundleRecords } from '../bundle.mjs';
import {
  assertJsonSafe,
  mergeRecordLists,
  mergeRecordsIntoBundle,
  readJsonArtifact,
  validateForPublish,
  writeFileAtomic,
} from '../publish.mjs';

export const name = 'json';

export function emit(records, ctx) {
  const { outDir, options = {}, provenance = {}, version = 1, generator = 'mothbake' } = ctx;
  const file = options.file ?? 'mothbake.json';
  const target = path.join(outDir, file);
  const label = `json emitter (${file})`;
  const includeProvenance = options.provenance !== false;
  const previous = options.merge ? readJsonArtifact(target, label) : null;

  let data;
  if (options.shape === 'records') {
    data = options.merge ? mergeRecordLists(previous, records) : records;
    if (!Array.isArray(data)) throw new Error(`${label}: shape "records" must produce an array`);
    assertJsonSafe(data, label);
  } else {
    const table = includeProvenance ? provenance : {};
    data = options.merge
      ? mergeRecordsIntoBundle(previous, records, { version, generator, provenance: table, keepProvenance: includeProvenance })
      : bundleRecords(records, { version, generator, provenance: table });
    validateForPublish(data, { expectedProvenance: includeProvenance ? Object.keys(provenance) : [], label });
  }

  writeFileAtomic(target, `${JSON.stringify(data, null, options.pretty ?? 2)}\n`);
  return [target];
}
