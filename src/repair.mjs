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

import path from 'node:path';
import { bakerTypes, resolveBakers } from './bakers/index.mjs';
import { bakeSpecs } from './bakers/specs.mjs';
import { summarizeRecords } from './bundle.mjs';
import { resolveEmitters, runEmitters } from './emitters/index.mjs';
import { selectJobs } from './runner.mjs';
import { readArchive } from './archive.mjs';
import { openRunJournal } from './run-journal.mjs';

function checkAbort(signal) {
  if (signal?.aborted) {
    const error = new Error('local repair aborted', { cause: signal.reason });
    error.name = 'AbortError';
    throw error;
  }
}

/**
 * Bake types whose inputs are entirely local. A record of one of these types
 * can be rebuilt from the raw archive with no API call: everything `ir`,
 * `echo-map`, `audio-clip` and `audio-stitch` read lives under `<out>/raw/<raw>/`.
 */
export const LOCAL_BAKE_TYPES = new Set(bakerTypes);

/** True when a job's bake type is rebuildable offline from its raw outputs. */
export function isLocalBake(job) {
  return Boolean(job) && bakeSpecs(job).length > 0 && bakeSpecs(job).every((bake) => LOCAL_BAKE_TYPES.has(bake.type));
}

/**
 * Read an archived raw run directory back into the `{ files, saved, result }`
 * shape bakers expect. Files are named `<sanitize(slot)>.<ext>`; the inline JSON
 * result is `result.json`. Declared slot names are restored through their
 * sanitized form so a slot like `Taps` still resolves.
 */
export function readRawResults(rawDir, rawName, outDir = path.dirname(rawDir), job = {}) {
  try {
    return readArchive({ outDir, rawName, rawDir, job });
  } catch (error) {
    if (/no raw outputs/.test(error.message)) return { files: new Map(), saved: new Map(), result: null, verified: false };
    throw error;
  }
}

/**
 * Rebuild the local-type records for every enabled job (optionally narrowed by
 * `only`) that has a raw archive. Pure over the filesystem; missing archives and
 * baker errors are collected as `failures` rather than thrown.
 *
 * @param {{
 *   config: object, configDir?: string, outDir: string,
 *   only?: string|string[]|null, log?: (message: string) => void,
 *   signal?: AbortSignal,
 * }} options
 */
export function rebuildLocalBakes(options = {}) {
  const {
    config,
    configDir = process.cwd(),
    outDir,
    only = null,
    log = () => {},
    signal,
  } = options;
  checkAbort(signal);
  const jobs = selectJobs(config, only).filter((job) => job.enabled !== false && isLocalBake(job));
  const bakers = resolveBakers(config);
  const records = [];
  const provenance = {};
  const failures = [];

  for (const job of jobs) {
    checkAbort(signal);
    options.onJob?.(job.id);
    const rawName = job.raw || job.id;
    try {
      const { files, saved, result, verified } = readArchive({ outDir, rawName, job });
      const specs = bakeSpecs(job);
      for (const bake of specs) {
        checkAbort(signal);
        const type = bake.type;
        const baker = bakers[type];
        if (!baker) throw new Error(`unknown baker: ${type}`);
        const fragment = baker(job, { files, saved, result, bake, job, rawName, outDir, configDir, log });
        checkAbort(signal);
        records.push({ job: job.id, type, ...fragment });
        options.onRecord?.(records.at(-1));
        log(`  rebuilt ${fragment.bucket}.${fragment.key}`);
      }
      provenance[job.id] = {
        engine: job.engine,
        jobId: job.jobId || null,
        mode: job.mode ?? job.params?.mode ?? null,
        name: specs.length === 1 ? specs[0].name ?? null : null,
        names: specs.map((bake) => bake.name ?? null),
        credits: job.credits ?? null,
        archiveVerification: verified ? 'hash-verified' : 'legacy-unverified',
      };
    } catch (error) {
      checkAbort(signal);
      log(`  FAILED: ${error.message}`);
      failures.push({ id: job.id, engine: job.engine, message: error.message });
    }
    options.onJob?.(null);
  }

  checkAbort(signal);

  return { records, provenance, failures };
}

/**
 * Rebuild the local records and run the configured emitters over them.
 *
 * @param {{
 *   config: object, configDir?: string, outDir: string,
 *   only?: string|string[]|null, log?: (message: string) => void,
 *   signal?: AbortSignal, breakLock?: boolean, journalOptions?: object,
 * }} options
 */
export async function repairConfig(options = {}) {
  const {
    config,
    configDir = process.cwd(),
    outDir,
    only = null,
    log = () => {},
    breakLock = false,
    journalOptions,
    signal,
  } = options;
  const journal = openRunJournal(outDir, { breakLock, ...journalOptions });
  let records = [];
  let activeJob = null;
  try {
    const version = config.version ?? 1;
    const generator = config.generator ?? 'mothbake';
    // Keep the writer lock across baking AND asynchronous emitter publication.
    // An emitter may await; another run must not publish in that interval.
    const { records: rebuilt, provenance, failures } = rebuildLocalBakes({
      config, configDir, outDir, only, signal,
      log,
      onJob(id) { activeJob = id; },
      onRecord(record) { records.push(record); },
    });
    records = rebuilt;
    checkAbort(signal);
    // Check between emitters too: an abort while one async emitter is awaiting
    // must not start the next publication step.
    const emitConfig = signal ? {
      ...config,
      emitters: resolveEmitters(config).map(({ emit }) => async (items, context) => {
        checkAbort(signal);
        const paths = await emit(items, { ...context, config });
        checkAbort(signal);
        return paths;
      }),
    } : config;
    const written = records.length
      ? await runEmitters({ config: emitConfig, records, outDir, provenance, version, generator, log })
      : [];
    checkAbort(signal);
    return { records, provenance, failures, written, outDir, buckets: summarizeRecords(records) };
  } catch (error) {
    // Do not invent journal entries for a raw-only offline repair. Preserve
    // existing remote IDs and make interruption of known local work durable.
    const ids = new Set(records.map((record) => record.job));
    if (activeJob) ids.add(activeJob);
    for (const id of ids) {
      const current = journal.get(id);
      if (current && current.state !== 'unknown-submission' && current.state !== 'remote-failed') {
        journal.transition(id, 'local-failed', { detail: signal?.aborted ? 'local repair aborted' : 'repair emission failed' });
      }
    }
    throw error;
  } finally {
    journal.close();
  }
}
