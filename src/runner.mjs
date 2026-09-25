// Runner: resolve each job's result (recorded fixture, reused job id, or a
// live API submission), save raw outputs, bake portable records, then hand
// them to the configured emitters.
//
// Nothing game-specific lives here: buckets, keys and payload shapes come
// from the bakers the config names.

import fs from 'node:fs';
import path from 'node:path';
import { createApi, resolveBaseUrl } from './api.mjs';
import { archiveResponse, readArchive } from './archive.mjs';
import { resolveBakers } from './bakers/index.mjs';
import { bakeSpecs } from './bakers/specs.mjs';
import { summarizeRecords } from './bundle.mjs';
import { runEmitters } from './emitters/index.mjs';
import { assertSpendApproved, buildExecutionPlan, IMPLEMENTATION_ID } from './execution-plan.mjs';
import { exportFingerprint, generationInstanceFingerprint, hashFile, hashJson, localBakeFingerprint, recordedFixtureFingerprint } from './identity.mjs';
import { buildJobGraph } from './job-graph.mjs';
import { writeFileAtomic } from './publish.mjs';
import { openRunJournal, readRunJournal } from './run-journal.mjs';
import { generateValues, generators as builtinGenerators } from './values.mjs';

/** Normalize `--only` values (repeatable and comma separated) to a Set. */
export function normalizeOnly(only) {
  if (!only) return null;
  const list = Array.isArray(only) ? only : [only];
  const set = new Set();
  for (const item of list) {
    for (const part of String(item).split(',')) {
      if (part.trim()) set.add(part.trim());
    }
  }
  return set.size ? set : null;
}

/** Select jobs, validating explicit `--only` ids against the config. */
export function selectJobs(config, only) {
  const jobs = config.jobs ?? [];
  const set = normalizeOnly(only);
  if (!set) return jobs;
  return buildJobGraph(config, { only: set }).jobs;
}

/** Jobs that may contact the API for a given run (used for the key check). */
export function jobsRequiringApi(config, options = {}) {
  const { only, force = false } = options;
  return selectJobs(config, only).filter((job) => job.enabled !== false && (force || !job.recorded));
}

function loadRecorded(job, configDir) {
  const files = new Map();
  const sources = new Map();
  for (const [slot, relative] of Object.entries(job.recorded.outputs || {})) {
    const file = path.resolve(configDir, relative);
    if (!fs.existsSync(file)) throw new Error(`recorded output "${slot}" not found: ${file}`);
    files.set(slot, fs.readFileSync(file));
    sources.set(slot, relative);
  }
  let result = null;
  if (typeof job.recorded.result === 'string') {
    const file = path.resolve(configDir, job.recorded.result);
    if (!fs.existsSync(file)) throw new Error(`recorded result not found: ${file}`);
    result = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else if (job.recorded.result !== undefined) {
    result = job.recorded.result;
  }
  return { files, sources, result, recorded: true };
}

/** Normalize an `inputFrom` reference to `{ job, slot }` (slot defaults to the input slot). */
function normalizeInputRef(ref, slot) {
  if (typeof ref === 'string') {
    const [job, outputSlot] = ref.split('/');
    return { job, slot: outputSlot || slot };
  }
  return { job: ref.job, slot: ref.slot || slot };
}

/**
 * Resolve `job.inputFrom` entries to asset ids without paying for the source
 * job again. Resolution uses only this run's captured asset id or a re-upload
 * of this run's freshly verified archive. Persisted mutable ids are retained
 * for compatibility/provenance but cannot satisfy a changed dependency edge.
 */
async function resolveInputFrom({ inputFrom, config, runAssets, outDir, api, log, signal }) {
  const resolved = {};
  for (const [slot, rawRef] of Object.entries(inputFrom ?? {})) {
    const ref = normalizeInputRef(rawRef, slot);
    const label = `${ref.job}/${ref.slot}`;
    const prior = runAssets.get(ref.job);
    const priorAsset = prior?.assetIds?.[ref.slot];
    if (priorAsset) {
      resolved[slot] = priorAsset;
      log(`  inputFrom ${slot} <- ${label} (asset ${priorAsset})`);
      continue;
    }
    const configJob = (config.jobs ?? []).find((candidate) => candidate.id === ref.job);
    // The graph always includes ancestors. If this run did not verify/rebuild
    // the ancestor, consuming its mutable config assetIds or an old raw path
    // would silently cross a recipe change. Only this run's captured asset or
    // freshly verified archived bytes may satisfy the edge.
    if (!prior) throw new Error(`inputFrom "${slot}": dependency ${label} did not complete in this run; refusing stale persisted output`);
    const source = prior.saved?.get(ref.slot)?.file;
    if (source && fs.existsSync(source)) {
      resolved[slot] = await api.uploadAsset(source, { signal });
      log(`  inputFrom ${slot} <- ${label} (re-uploaded ${path.relative(outDir, source)})`);
      continue;
    }
    throw new Error(`inputFrom "${slot}": cannot resolve ${label} from this run's verified outputs`);
  }
  return resolved;
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('run aborted');
}

function assertExecutable(job, inputs, configDir, generatorRegistry, planEntry, signal) {
  assertNotAborted(signal);
  const expected = planEntry.executable;
  const params = { ...(job.params ?? {}) };
  const generated = generateValues(job, generatorRegistry);
  if (generated !== null) params.values = generated;
  if (hashJson({ engine: job.engine, mode: job.mode ?? null, params }) !== hashJson({ engine: expected.engine, mode: expected.mode, params: expected.params })) {
    throw new Error(`approved plan invalidated: executable params or generated values changed for "${job.id}"`);
  }
  for (const [slot, relative] of Object.entries(inputs)) {
    const file = path.resolve(configDir, relative);
    if (!fs.existsSync(file) || hashFile(file) !== expected.inputHashes[slot]) {
      throw new Error(`approved plan invalidated: input bytes changed for "${job.id}" slot "${slot}"`);
    }
  }
  if (Object.keys(inputs).length !== Object.keys(expected.inputHashes).length) throw new Error(`approved plan invalidated: input slots changed for "${job.id}"`);
  return params;
}

async function resolveLiveResult({ api, job, inputs, inputFrom, config, runAssets, configDir, outDir, log, generatorRegistry, journal, planEntry, signal }) {
  const existingId = planEntry.jobId;
  if (existingId) {
    log(`  ${planEntry.action === 'legacy-reuse' ? 'checking legacy' : 'resuming'} job ${existingId}`);
    let status;
    try {
      status = await api.jobStatus(existingId, { signal });
    } catch (error) {
      journal.transition(job.id, 'local-failed', { detail: 'status request failed' });
      throw new Error(
        `recorded job "${job.id}" (${existingId}) could not be verified: ${error.message}. `
          + 'Refusing to submit a fresh job automatically; resume after status access is restored.',
      );
    }
    const state = status?.status;
    if (typeof state !== 'string' || !state) {
      journal.transition(job.id, 'local-failed', { jobId: existingId, detail: 'status response omitted state' });
      throw new Error(`recorded job "${job.id}" (${existingId}) returned an unknown status; refusing to submit or poll blindly`);
    }
    if (state === 'failed' || state === 'cancelled') {
      journal.transition(job.id, 'remote-failed', { jobId: existingId, detail: state });
      throw new Error(`recorded job "${job.id}" (${existingId}) is ${state}; refusing to submit a replacement automatically`);
    }
    if (state !== 'completed') {
      journal.transition(job.id, 'polling', { jobId: existingId });
      try {
        await api.waitForJob(existingId, { log, signal });
      } catch (error) {
        const terminal = error?.status === 'failed' || error?.status === 'cancelled';
        journal.transition(job.id, terminal ? 'remote-failed' : 'local-failed', { jobId: existingId, detail: terminal ? String(error.status) : 'polling interrupted' });
        throw error;
      }
    }
    journal.transition(job.id, 'completed', { jobId: existingId });
    job.jobId = existingId;
    try {
      return await api.jobResult(existingId, { signal });
    } catch (error) {
      journal.transition(job.id, 'local-failed', { jobId: existingId, detail: 'result retrieval failed' });
      throw error;
    }
  }
  let params = assertExecutable(job, inputs, configDir, generatorRegistry, planEntry, signal);
  const fromAssets = await resolveInputFrom({ inputFrom, config, runAssets, outDir, api, log, signal });
  const inputEntries = Object.entries(inputs);
  let inputFiles;
  if (inputEntries.length || Object.keys(fromAssets).length) {
    inputFiles = {};
    for (const [slot, relative] of inputEntries) {
      const file = path.resolve(configDir, relative);
      if (!fs.existsSync(file)) {
        throw new Error(`input "${slot}" not found: ${file} (run "mothbake sources" to generate source art)`);
      }
      assertExecutable(job, inputs, configDir, generatorRegistry, planEntry, signal);
      inputFiles[slot] = await api.uploadAsset(file, { signal });
    }
    // An explicit inputFrom wins over a file input for the same slot (config warns).
    for (const [slot, assetId] of Object.entries(fromAssets)) inputFiles[slot] = assetId;
  }
  params = assertExecutable(job, inputs, configDir, generatorRegistry, planEntry, signal);
  if (hashJson({ engine: job.engine, mode: job.mode ?? null, params }) !== hashJson({ engine: planEntry.executable.engine, mode: planEntry.executable.mode, params: planEntry.executable.params })) throw new Error(`approved plan invalidated: request body changed for "${job.id}"`);
  journal.transition(job.id, 'submitting', { metadata: { recipeFingerprint: planEntry.recipeFingerprint } });
  let submitted;
  try {
    submitted = await api.submitJob(job.engine, { params, inputFiles, mode: job.mode, signal });
  } catch (error) {
    journal.transition(job.id, error?.ambiguous ? 'unknown-submission' : 'local-failed', {
      detail: error?.ambiguous ? 'submit outcome is ambiguous; manual reconciliation required' : 'submit rejected before a job id was received',
    });
    throw error;
  }
  if (!submitted?.job_id) {
    journal.transition(job.id, 'unknown-submission', { detail: 'submit response contained no job id; manual reconciliation required' });
    throw new Error(`submit for "${job.id}" returned no job_id; the outcome is ambiguous and will not be resubmitted automatically`);
  }
  log(`  submitted ${submitted.job_id}`);
  job.jobId = submitted.job_id;
  try {
    journal.transition(job.id, 'submitted', { jobId: submitted.job_id, metadata: { recipeFingerprint: planEntry.recipeFingerprint } });
  } catch (error) {
    const persisted = new Error(`job ${submitted.job_id} was accepted but its id could not be persisted: ${error.message}. Stop and preserve this job id; do not resubmit.`);
    persisted.jobId = submitted.job_id;
    throw persisted;
  }
  journal.transition(job.id, 'polling', { jobId: submitted.job_id });
  try {
    await api.waitForJob(submitted.job_id, { log, signal });
    journal.transition(job.id, 'completed', { jobId: submitted.job_id });
    return await api.jobResult(submitted.job_id, { signal });
  } catch (error) {
    const terminal = error?.status === 'failed' || error?.status === 'cancelled';
    journal.transition(job.id, terminal ? 'remote-failed' : 'local-failed', { jobId: submitted.job_id, detail: terminal ? String(error.status) : 'polling or result retrieval failed' });
    throw error;
  }
}

function writeBackJobIds({ config, configFile, writeBack, log }) {
  if (writeBack === false || !configFile || path.extname(configFile).toLowerCase() !== '.json') return false;
  const next = `${JSON.stringify(config, null, 2)}\n`;
  if (fs.readFileSync(configFile, 'utf8') === next) return false;
  writeFileAtomic(configFile, next);
  log(`recorded job ids in ${configFile}`);
  return true;
}

/**
 * Run a config.
 *
 * @param {{
 *   config: object, configFile?: string|null, configDir?: string,
 *   outDir?: string, key?: string|null, env?: object, base?: string,
 *   only?: string|string[]|null, force?: boolean, dry?: boolean,
 *   approveSpend?: string|null, breakLock?: boolean,
 *   strict?: boolean, writeBack?: boolean, log?: (message: string) => void,
 *   fetchImpl?: typeof fetch, sleepImpl?: (ms: number) => Promise<void>,
 *   nowImpl?: () => number, randomImpl?: () => number,
 *   maxApiResponseBytes?: number, maxDownloadBytes?: number, maxUploadBytes?: number,
 *   requestTimeoutMs?: number, uploadTimeoutMs?: number, downloadTimeoutMs?: number,
 *   signal?: AbortSignal,
 * }} options
 */
export async function runConfig(options = {}) {
  const {
    config,
    configFile = null,
    configDir = process.cwd(),
    outDir = path.resolve(process.cwd(), 'mothbake-out'),
    env = process.env,
    only = null,
    force = false,
    dry = false,
    strict = false,
    log = () => {},
  } = options;

  const bakers = resolveBakers(config);
  const generatorRegistry = { ...builtinGenerators, ...(config.generators || {}) };
  const version = config.version ?? 1;
  const generator = config.generator ?? 'mothbake';
  const records = [];
  const provenance = {};
  const failures = [];
  let recordedJobIds = false;
  let recordedAssetIds = false;
  const runAssets = new Map();
  const baseUrl = resolveBaseUrl({ base: options.base, configBaseUrl: config.baseUrl, env });
  const initialJournal = readRunJournal(outDir);
  let executionPlan = buildExecutionPlan({ config, configDir, outDir, only, force, baseUrl, journalSnapshot: initialJournal });

  if (dry) {
    for (const entry of executionPlan.jobs) {
      const descriptions = {
        recorded: 'read the recorded fixture',
        'archive-rebuild': 'verify the raw archive and rebuild locally',
        resume: `resume job ${entry.jobId}`,
        'legacy-reuse': `check unverified legacy job ${entry.jobId}`,
        'blocked-unknown-submission': 'stop for manual reconciliation of an ambiguous submit',
        'blocked-archive-conflict': 'stop because the raw archive is immutable',
         submit: 'submit to the API after explicit spending approval',
          'blocked-recipe-conflict': 'stop because journal recipe provenance differs',
      };
      log(`> ${entry.id} (${entry.engine}) — would ${descriptions[entry.action]}${entry.baker ? `, bake ${entry.baker}` : ''}`);
    }
    return { dry: true, records, provenance, failures, written: [], plan: executionPlan.jobs, executionPlan, buckets: summarizeRecords(records) };
  }

  // Fail before any local writes when a new paid plan has not been approved.
  assertSpendApproved(executionPlan, options.approveSpend ?? null);
  const journal = openRunJournal(outDir, {
    breakLock: options.breakLock ?? false,
    ...(options.journalOptions ?? {}),
  });
  try {
    // Re-plan under the writer lock so a changed resume state invalidates a
    // stale approval rather than being raced into execution.
    executionPlan = buildExecutionPlan({ config, configDir, outDir, only, force, baseUrl, journalSnapshot: journal.snapshot() });
    assertSpendApproved(executionPlan, options.approveSpend ?? null);
    const graph = buildJobGraph(config, { only });
    const jobsById = new Map(graph.jobs.map((job) => [job.id, job]));
    const api = createApi({ baseUrl, key: options.key ?? null, env, fetchImpl: options.fetchImpl, sleepImpl: options.sleepImpl, nowImpl: options.nowImpl, randomImpl: options.randomImpl, maxApiResponseBytes: options.maxApiResponseBytes, maxDownloadBytes: options.maxDownloadBytes, maxUploadBytes: options.maxUploadBytes, requestTimeoutMs: options.requestTimeoutMs, uploadTimeoutMs: options.uploadTimeoutMs, downloadTimeoutMs: options.downloadTimeoutMs, log });
    const bakedJobs = [];

    for (const planEntry of executionPlan.jobs) {
      assertNotAborted(options.signal);
      const job = jobsById.get(planEntry.id);
      const rawName = job.raw || job.id;
      const inputs = job.inputs ?? job.input ?? {};
      const jobBakeSpecs = bakeSpecs(job);
      log(`\n> ${job.id} (${job.engine}) — ${planEntry.action}`);
      try {
        assertNotAborted(options.signal);
        if (planEntry.action.startsWith('blocked-')) {
          const reason = planEntry.action === 'blocked-unknown-submission'
            ? `job "${job.id}" has an unknown submission outcome; reconcile and attach a confirmed job id before any retry`
            : planEntry.blockReason;
          throw new Error(reason);
        }
        const metadata = {
          recipeFingerprint: planEntry.recipeFingerprint,
          bakeConfigFingerprint: planEntry.bakeConfigFingerprint,
          exportConfigFingerprint: planEntry.exportConfigFingerprint,
          verification: planEntry.verification,
        };
        const currentDependencies = {};
        for (const [slot, dependency] of Object.entries(planEntry.dependencies)) {
          const prior = runAssets.get(dependency.job);
          if (!prior) throw new Error(`dependency ${dependency.job}/${dependency.slot} did not complete in this run`);
          if (hashJson(prior.selectedIdentity) !== hashJson(dependency.selectedIdentity)) {
            throw new Error(`dependency ${dependency.job}/${dependency.slot} selected generation changed; approval invalidated`);
          }
          currentDependencies[slot] = { ...dependency, actualGenerationFingerprint: prior.generationFingerprint, actualRawFingerprint: prior.rawFingerprint };
        }
        journal.transition(job.id, 'prepared', { jobId: planEntry.jobId ?? undefined, metadata: { ...metadata, dependencies: currentDependencies } });

        let archived;
        let generationFingerprint;
        if (planEntry.action === 'archive-rebuild') {
          archived = readArchive({ outDir, rawName, job, requireVerified: true });
          if (archived.manifest.recipeFingerprint !== planEntry.recipeFingerprint) {
            throw new Error(`raw/${rawName}: archived recipe no longer matches the current generation recipe`);
          }
          generationFingerprint = archived.manifest.generationFingerprint;
          if (generationFingerprint !== planEntry.selectedIdentity.generationFingerprint || archived.rawFingerprint !== planEntry.selectedIdentity.rawFingerprint) {
            throw new Error(`raw/${rawName}: selected generation changed after planning; approval invalidated`);
          }
          if (archived.manifest.jobId) job.jobId = archived.manifest.jobId;
          log(`  verified archived result ${archived.rawFingerprint}`);
        } else {
          let response;
          if (planEntry.action === 'recorded') {
            log('  using recorded fixture');
            for (const [slot, relative] of Object.entries(job.recorded.outputs ?? {})) {
              const file = path.resolve(configDir, relative);
              if (fs.existsSync(file) && hashFile(file) !== planEntry.recorded.outputs[slot]) throw new Error(`recorded fixture changed after planning: ${job.id}/${slot}`);
            }
            if (typeof job.recorded.result === 'string') {
              const file = path.resolve(configDir, job.recorded.result);
              if (fs.existsSync(file) && hashFile(file) !== planEntry.recorded.result) throw new Error(`recorded fixture changed after planning: ${job.id}/result`);
            } else if (job.recorded.result !== undefined && hashJson(job.recorded.result) !== planEntry.recorded.result) throw new Error(`recorded fixture changed after planning: ${job.id}/result`);
            response = loadRecorded(job, configDir);
            generationFingerprint = generationInstanceFingerprint({ recipe: planEntry.recipeFingerprint, jobId: `recorded:${job.id}`, fixture: recordedFixtureFingerprint(planEntry.recorded) });
          } else {
            if (!options.key) throw new Error(`MOTH_API_KEY is required to ${planEntry.action === 'submit' ? 'submit' : 'resume'} live job "${job.id}"`);
            const previousJobId = job.jobId;
            response = await resolveLiveResult({ api, job, inputs, inputFrom: job.inputFrom, config, runAssets, configDir, outDir, log, generatorRegistry, journal, planEntry, signal: options.signal });
            if (job.jobId && job.jobId !== previousJobId) recordedJobIds = true;
            generationFingerprint = generationInstanceFingerprint({ recipe: planEntry.recipeFingerprint, jobId: job.jobId });
          }
          archived = await archiveResponse({
            response,
            api,
            outDir,
            rawName,
            recipeFingerprint: planEntry.recipeFingerprint,
            generationFingerprint,
            jobId: job.jobId ?? null,
            engine: job.engine,
            verification: planEntry.verification,
            signal: options.signal,
            log,
          });
        }
        assertNotAborted(options.signal);
        const { files, saved } = archived;
        journal.transition(job.id, 'downloaded', {
          jobId: job.jobId ?? undefined,
          metadata: { ...metadata, generationFingerprint, rawFingerprint: archived.rawFingerprint },
        });
        const assetIds = {};
        for (const [slot, entry] of saved) if (entry.assetId) assetIds[slot] = entry.assetId;
        runAssets.set(job.id, { assetIds, saved, generationFingerprint, rawFingerprint: archived.rawFingerprint, selectedIdentity: planEntry.selectedIdentity });
        if (Object.keys(assetIds).length) {
          const before = job.assetIds ? JSON.stringify(job.assetIds) : null;
          job.assetIds = assetIds;
          if (JSON.stringify(assetIds) !== before) recordedAssetIds = true;
        }

        let bakeFingerprint = null;
        if (jobBakeSpecs.length) {
          const fingerprints = [];
          for (const bake of jobBakeSpecs) {
            assertNotAborted(options.signal);
            const bakeType = bake.type;
            const baker = bakers[bakeType];
            if (!baker) throw new Error(`unknown baker: ${bakeType}`);
            const fragment = baker(job, { files, saved, result: archived.result, bake, job, rawName, outDir, configDir, log });
            const record = { job: job.id, type: bakeType, ...fragment };
            records.push(record);
            fingerprints.push(localBakeFingerprint({ raw: archived.rawFingerprint, bake: { implementation: IMPLEMENTATION_ID, options: bake } }));
            log(`  baked ${record.bucket}.${record.key}${record.merge === 'frames' ? `[${record.index ?? 0}]` : ''}`);
          }
          bakeFingerprint = fingerprints.length === 1 ? fingerprints[0] : localBakeFingerprint({ raw: archived.rawFingerprint, bake: { implementation: IMPLEMENTATION_ID, outputs: fingerprints } });
          journal.transition(job.id, 'baked', { metadata: { bakeFingerprint } });
        }
        provenance[job.id] = {
          engine: job.engine,
          engineVersion: job.engineVersion ?? null,
          jobId: job.jobId || null,
          requestedMode: job.mode ?? job.params?.mode ?? null,
          mode: job.mode ?? job.params?.mode ?? null,
          actualBackend: null,
          name: jobBakeSpecs.length === 1 ? jobBakeSpecs[0].name ?? null : null,
          names: jobBakeSpecs.map((bake) => bake.name ?? null),
          estimatedCredits: job.credits ?? null,
          credits: job.credits ?? null,
          verification: planEntry.verification,
          recipeFingerprint: planEntry.recipeFingerprint,
          generationFingerprint,
          rawFingerprint: archived.rawFingerprint,
          bakeFingerprint,
        };
        if (Object.keys(assetIds).length) provenance[job.id].outputs = assetIds;
        bakedJobs.push({ job, bakeFingerprint, planEntry });
      } catch (error) {
        const current = journal.get(job.id);
        if (current && !['unknown-submission', 'remote-failed', 'local-failed'].includes(current.state)) {
          journal.transition(job.id, 'local-failed', {
            detail: error?.assetId ? `asset operation uncertain for ${error.assetId}` : 'local execution stage failed',
            metadata: error?.assetId ? { ambiguousAssetId: error.assetId } : undefined,
          });
        }
        log(`  FAILED: ${error.message}`);
        failures.push({ id: job.id, engine: job.engine, message: error.message });
        if (strict || options.signal?.aborted) throw error;
      }
    }

    let written = [];
    if (records.length) {
      try {
        assertNotAborted(options.signal);
        written = await runEmitters({ config, records, outDir, provenance, version, generator, log });
        assertNotAborted(options.signal);
        for (const { job, bakeFingerprint, planEntry } of bakedJobs) {
          const publishedFingerprint = exportFingerprint({ bake: bakeFingerprint ?? planEntry.recipeFingerprint, emitter: { configFingerprint: planEntry.exportConfigFingerprint } });
          journal.transition(job.id, 'published', { metadata: { exportFingerprint: publishedFingerprint } });
          provenance[job.id].exportFingerprint = publishedFingerprint;
        }
      } catch (error) {
        for (const { job } of bakedJobs) journal.transition(job.id, 'local-failed', { detail: 'emitter publication failed' });
        throw error;
      }
    }
    const updatedConfig = (recordedJobIds || recordedAssetIds) && writeBackJobIds({ config, configFile, writeBack: options.writeBack, log });
    return {
      dry: false,
      records,
      provenance,
      failures,
      written,
      plan: executionPlan.jobs,
      executionPlan,
      buckets: summarizeRecords(records),
      outDir,
      updatedConfig,
    };
  } finally {
    journal.close();
  }
}
