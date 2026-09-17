// Bundle portable records into the aggregate shape shared by the `json` and
// `esm` emitters:
//
//   { version, generator, provenance, <bucket>: { <key>: value | { fps, frames } } }
//
// Effect frames that share a bucket+key merge into `{ fps, frames: [...] }`
// with any gaps removed. Buckets appear in first-seen order, so output is
// deterministic for a deterministic job list.

export function bundleRecords(records, options = {}) {
  const { version = 1, generator = 'mothbake', provenance = {} } = options;
  const buckets = {};
  for (const record of records) {
    const bucket = buckets[record.bucket] || (buckets[record.bucket] = {});
    if (record.merge === 'frames') {
      const entry = bucket[record.key] || (bucket[record.key] = { fps: record.fps ?? 10, frames: [] });
      if (record.fps != null) entry.fps = record.fps;
      entry.frames[record.index ?? 0] = record.value;
    } else {
      bucket[record.key] = record.value;
    }
  }
  for (const bucket of Object.values(buckets)) {
    for (const entry of Object.values(bucket)) {
      if (Array.isArray(entry.frames)) entry.frames = entry.frames.filter(Boolean);
    }
  }
  return { version, generator, provenance, ...buckets };
}

/** Count records per bucket, for CLI summaries. */
export function summarizeRecords(records) {
  const buckets = {};
  for (const record of records) buckets[record.bucket] = (buckets[record.bucket] || 0) + 1;
  return buckets;
}
