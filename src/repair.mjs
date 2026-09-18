// Offline repair: rebuild purely local, file-derived records from the raw
// outputs already archived under `<outDir>/raw/<raw>/` — no API, no key, no
// credits.
//
// This is the portable counterpart of the upstream `rebuildLocalBakes` path.
// `ir`/`ir-descriptor`, `echo-map` and the file-derived audio records
// (`audio-clip`/`audio-stitch`) are pure functions of the archived raw result,
// so a baker fix can be re-applied without paying for the engine run again —
// the same way `audio-clip` with `embed: false` is rebuilt beside its
// descriptor.
//
// Records are rebuilt in config order and handed to the configured emitters, so
// `mothbake repair` reproduces the local artifacts deterministically.

import fs from 'node:fs';
import path from 'node:path';
import { resolveBakers } from './bakers/index.mjs';
import { summarizeRecords } from './bundle.mjs';
import { runEmitters } from './emitters/index.mjs';
import { selectJobs } from './runner.mjs';

/**
 * Bake types whose inputs are entirely local. A record of one of these types
 * can be rebuilt from the raw archive with no API call: everything `ir`,
 * `echo-map`, `audio-clip` and `audio-stitch` read lives under `<out>/raw/<raw>/`.
 */
export const LOCAL_BAKE_TYPES = new Set(['ir', 'ir-descriptor', 'echo-map', 'audio-clip', 'audio-stitch']);

/** True when a job's bake type is rebuildable offline from its raw outputs. */
export function isLocalBake(job) {
  return Boolean(job) && LOCAL_BAKE_TYPES.has(job.bake?.type);
}

const sanitize = (name) => String(name).replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();

/** Slot names a job's baker may read, so sanitized archive names map back. */
function declaredSlots(job) {
  const bake = job.bake ?? {};
  const slots = new Set(['result']);
  for (const key of ['slot', 'tapsSlot', 'irSlot']) {
    if (typeof bake[key] === 'string' && bake[key]) slots.add(bake[key]);
  }
  const order = bake.slots ?? bake.order;
  if (Array.isArray(order)) {
    for (const entry of order) {
      if (typeof entry === 'string' && entry) slots.add(entry);
      else if (entry && typeof entry.slot === 'string' && entry.slot) slots.add(entry.slot);
    }
  }
  return slots;
}

/**
 * Read an archived raw run directory back into the `{ files, saved, result }`
 * shape bakers expect. Files are named `<sanitize(slot)>.<ext>`; the inline JSON
 * result is `result.json`. Declared slot names are restored through their
 * sanitized form so a slot like `Taps` still resolves.
 */
export function readRawResults(rawDir, rawName, outDir = path.dirname(rawDir), job = {}) {
  const files = new Map();
  const saved = new Map();
  let result = null;
  if (!fs.existsSync(rawDir)) return { files, saved, result };
  const bySanitized = new Map();
  for (const slot of declaredSlots(job)) bySanitized.set(sanitize(slot), slot);
  for (const name of fs.readdirSync(rawDir).sort()) {
    const file = path.join(rawDir, name);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (name === 'result.json') {
      try {
        result = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        result = null;
      }
      continue;
    }
    const extension = path.extname(name);
    const stem = extension ? name.slice(0, -extension.length) : name;
    const slot = bySanitized.get(stem) ?? stem;
    files.set(slot, fs.readFileSync(file));
    saved.set(slot, {
      file,
      relative: path.relative(outDir, file),
      contentType: null,
      assetId: null,
    });
  }
  return { files, saved, result };
}

/**
 * Rebuild the local-type records for every enabled job (optionally narrowed by
 * `only`) that has a raw archive. Pure over the filesystem; missing archives and
 * baker errors are collected as `failures` rather than thrown.
 *
 * @param {{
 *   config: object, configDir?: string, outDir: string,
 *   only?: string|string[]|null, log?: (message: string) => void,
 * }} options
 */
export function rebuildLocalBakes(options = {}) {
  const {
    config,
    configDir = process.cwd(),
    outDir,
    only = null,
    log = () => {},
  } = options;
  const jobs = selectJobs(config, only).filter((job) => job.enabled !== false && isLocalBake(job));
  const bakers = resolveBakers(config);
  const records = [];
  const provenance = {};
  const failures = [];

  for (const job of jobs) {
    const type = job.bake.type;
    const rawName = job.raw || job.id;
    const rawDir = path.join(outDir, 'raw', rawName);
    if (!fs.existsSync(rawDir)) {
      const message = `no raw outputs at ${path.relative(outDir, rawDir) || rawDir}; nothing to rebuild`;
      log(`- ${job.id}: ${message}`);
      failures.push({ id: job.id, engine: job.engine, message });
      continue;
    }
    try {
      const { files, saved, result } = readRawResults(rawDir, rawName, outDir, job);
      const baker = bakers[type];
      if (!baker) throw new Error(`unknown baker: ${type}`);
      const fragment = baker(job, { files, saved, result, bake: job.bake, job, rawName, outDir, configDir, log });
      records.push({ job: job.id, type, ...fragment });
      provenance[job.id] = {
        engine: job.engine,
        jobId: job.jobId || null,
        mode: job.mode || job.params?.mode || 'emu',
        name: job.bake?.name ?? null,
        credits: job.credits ?? null,
      };
      log(`  rebuilt ${fragment.bucket}.${fragment.key}`);
    } catch (error) {
      log(`  FAILED: ${error.message}`);
      failures.push({ id: job.id, engine: job.engine, message: error.message });
    }
  }

  return { records, provenance, failures };
}

/**
 * Rebuild the local records and run the configured emitters over them.
 *
 * @param {{
 *   config: object, configDir?: string, outDir: string,
 *   only?: string|string[]|null, log?: (message: string) => void,
 * }} options
 */
export async function repairConfig(options = {}) {
  const {
    config,
    configDir = process.cwd(),
    outDir,
    only = null,
    log = () => {},
  } = options;
  const version = config.version ?? 1;
  const generator = config.generator ?? 'mothbake';
  const { records, provenance, failures } = rebuildLocalBakes({ config, configDir, outDir, only, log });
  const written = records.length
    ? await runEmitters({ config, records, outDir, provenance, version, generator, log })
    : [];
  return {
    records,
    provenance,
    failures,
    written,
    outDir,
    buckets: summarizeRecords(records),
  };
}
