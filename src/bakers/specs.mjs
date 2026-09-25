/** Normalize a job's compatible single `bake` or multi-output `bakes` list. */
export function bakeSpecs(job = {}) {
  if (Array.isArray(job.bakes)) return job.bakes;
  return job.bake ? [job.bake] : [];
}
