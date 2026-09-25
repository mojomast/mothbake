// Frozen, structured execution planning. Planning is local and read-only: it
// hashes source bytes and recipes but never creates the output directory,
// contacts Moth, or mutates a journal.

import fs from 'node:fs';
import path from 'node:path';
import { buildJobGraph } from './job-graph.mjs';
import { hashBytes, hashFile, hashJson, recipeFingerprint } from './identity.mjs';
import { bakeSpecs } from './bakers/specs.mjs';
import { readArchive } from './archive.mjs';
import { loadContractSnapshot } from './engine-contracts.mjs';
import { generateValues, generators as builtinGenerators } from './values.mjs';

export const EXECUTION_PLAN_VERSION = 1;
export const IMPLEMENTATION_ID = 'mothbake@0.1.0';

const functionIdentity = (fn) => ({
  kind: 'trusted-local-function',
  name: fn.name || null,
  sourceHash: hashBytes(Buffer.from(Function.prototype.toString.call(fn))),
});

function emitterSpecs(config) {
  const specs = config.emitters ?? (config.emitter !== undefined ? [config.emitter] : [{ type: 'files' }]);
  return specs.map((entry) => {
    if (typeof entry === 'function') return functionIdentity(entry);
    if (entry && typeof entry === 'object' && typeof entry.emit === 'function') {
      return { ...functionIdentity(entry.emit), name: entry.name ?? entry.emit.name ?? null, options: entry.options ?? {} };
    }
    return entry;
  });
}

function inputHashes(job, configDir, { allowMissing = false } = {}) {
  const hashes = {};
  for (const [slot, relative] of Object.entries(job.inputs ?? job.input ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const file = path.resolve(configDir, relative);
    if (!fs.existsSync(file)) {
      if (allowMissing) {
        hashes[slot] = { status: 'unavailable-recorded-input', declaredPath: relative };
        continue;
      }
      throw new Error(`input "${slot}" not found: ${file} (run "mothbake sources" to generate source art)`);
    }
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error(`input "${slot}" is not a file: ${file}`);
    hashes[slot] = hashFile(file);
  }
  return hashes;
}

function recordedHashes(job, configDir) {
  if (!job.recorded) return null;
  const outputs = {};
  for (const [slot, relative] of Object.entries(job.recorded.outputs ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const file = path.resolve(configDir, relative);
    outputs[slot] = fs.existsSync(file) ? hashFile(file) : { status: 'missing', declaredPath: relative };
  }
  let result = null;
  if (typeof job.recorded.result === 'string') {
    const file = path.resolve(configDir, job.recorded.result);
    result = fs.existsSync(file) ? hashFile(file) : { status: 'missing', declaredPath: job.recorded.result };
  } else if (job.recorded.result !== undefined) {
    result = hashJson(job.recorded.result);
  }
  return { outputs, result };
}

function chooseAction({ job, force, journal, recipe, outDir, recorded }) {
  if (typeof job.engine === 'string' && job.engine.startsWith('local:')) {
    return {
      action: 'blocked-local-engine',
      verification: 'local-engine',
      jobId: null,
      blockReason: `engine "${job.engine}" is a local backend and cannot be submitted to Moth; run it through the explicit local backend command with its configured backend path`,
    };
  }
  if (recorded && !force) return { action: 'recorded', verification: 'recorded-fixture' };
  if (journal && !journal.jobId && ['unknown-submission', 'submitting'].includes(journal.state)) {
    return { action: 'blocked-unknown-submission', verification: 'ambiguous', jobId: null };
  }
  const matches = journal?.metadata?.recipeFingerprint === recipe;
  if (journal?.metadata?.recipeFingerprint && !matches) {
    return { action: 'blocked-recipe-conflict', verification: 'journal-conflict', jobId: journal.jobId ?? job.jobId, blockReason: `job "${job.id}" has journal provenance for a different recipe; choose a new raw name and reconcile the old job before reuse` };
  }
  const rawDir = path.join(outDir, 'raw', job.raw || job.id);
  const hasVerifiedArchive = matches && typeof journal?.metadata?.rawFingerprint === 'string' && fs.existsSync(rawDir);
  if (!force && hasVerifiedArchive && ['downloaded', 'baked', 'published', 'local-failed'].includes(journal.state)) {
    try {
      const archived = readArchive({ outDir, rawName: job.raw || job.id, job, requireVerified: true });
      if (archived.manifest.recipeFingerprint !== recipe || archived.rawFingerprint !== journal.metadata.rawFingerprint) throw new Error('journal and archive fingerprints disagree');
      return { action: 'archive-rebuild', verification: journal.metadata.verification ?? 'journal-verified', jobId: journal.jobId ?? null };
    } catch (error) {
      return { action: 'blocked-archive-conflict', verification: 'archive-invalid', jobId: journal.jobId ?? null, blockReason: error.message };
    }
  }
  if (!force && matches && journal?.jobId) {
    return { action: 'resume', verification: journal.metadata.verification ?? 'journal-verified', jobId: journal.jobId };
  }
  if (fs.existsSync(rawDir)) {
    let archived;
    try { archived = readArchive({ outDir, rawName: job.raw || job.id, job, requireVerified: true }); }
    catch (error) {
      return { action: 'blocked-archive-conflict', verification: 'archive-invalid', jobId: journal?.jobId ?? job.jobId ?? null, blockReason: error.message };
    }
    if (!force && archived.manifest.recipeFingerprint === recipe) {
      return { action: 'archive-rebuild', verification: archived.manifest.verification ?? 'journal-verified', jobId: archived.manifest.jobId ?? null };
    }
    return {
      action: 'blocked-archive-conflict',
      verification: 'archive-preserved',
      jobId: archived.manifest.jobId ?? null,
      blockReason: `raw/${job.raw || job.id} already preserves a different generation; choose a new raw name before fresh submission`,
    };
  }
  if (!force && job.jobId) {
    return { action: 'legacy-reuse', verification: 'legacy-unverified', jobId: job.jobId };
  }
  return { action: 'submit', verification: 'new-request', jobId: null };
}

/**
 * Build a deterministic plan. `journalSnapshot` is optional and must come from
 * readRunJournal/openRunJournal. The returned fingerprint excludes display-only
 * explanations and is the value a caller must explicitly approve before any
 * new paid submission.
 */
export function buildExecutionPlan(options = {}) {
  const {
    config,
    configDir = process.cwd(),
    outDir = path.resolve(process.cwd(), 'mothbake-out'),
    only = null,
    force = false,
    baseUrl = config?.baseUrl ?? null,
    journalSnapshot = null,
  } = options;
  const graph = buildJobGraph(config, { only });
  const contractSnapshot = config.contractSnapshot
    ? loadContractSnapshot(path.resolve(configDir, config.contractSnapshot))
    : null;
  const selected = new Map();
  const jobs = [];
  let estimatedCredits = 0;
  let unknownCost = 0;
  let submissions = 0;
  const exportConfigFingerprint = hashJson({ implementation: IMPLEMENTATION_ID, emitters: emitterSpecs(config) });

  for (const job of graph.jobs) {
    const contract = contractSnapshot?.engines?.[job.engine] ?? null;
    const dependencies = {};
    for (const ref of graph.dependencies.get(job.id) ?? []) {
      const ancestor = selected.get(ref.job);
      dependencies[ref.inputSlot] = { job: ref.job, slot: ref.slot, recipeFingerprint: ancestor.recipeFingerprint, selectedIdentity: ancestor.selectedIdentity };
    }
    const hashes = inputHashes(job, configDir, { allowMissing: Boolean(job.recorded && !force) });
    const params = structuredClone(job.params ?? {});
    const generated = generateValues(job, { ...builtinGenerators, ...(config.generators ?? {}) });
    if (generated !== null) params.values = generated;
    const recipe = recipeFingerprint({
      engine: job.engine,
      backend: baseUrl,
      mode: job.mode ?? job.params?.mode ?? null,
      version: job.engineVersion ?? contract?.version ?? null,
      params: job.params ?? {},
      inputHashes: hashes,
      generator: job.generateValues ? {
        implementation: config.generators?.[job.generateValues.type]
          ? functionIdentity(config.generators[job.generateValues.type])
          : `${IMPLEMENTATION_ID}:values-v1`,
        spec: job.generateValues,
      } : null,
      dependencies,
    });
    const recorded = recordedHashes(job, configDir);
    const journal = journalSnapshot?.jobs?.[job.id] ?? null;
    const choice = chooseAction({ job, force, journal, recipe, outDir, recorded });
    let selectedIdentity = { recipeFingerprint: recipe };
    if (choice.action === 'recorded') selectedIdentity = { recipeFingerprint: recipe, recorded };
    else if (choice.action === 'archive-rebuild') {
      const archived = readArchive({ outDir, rawName: job.raw || job.id, job, requireVerified: true });
      selectedIdentity = { recipeFingerprint: recipe, generationFingerprint: archived.manifest.generationFingerprint, rawFingerprint: archived.rawFingerprint };
    } else if (choice.jobId && ['resume', 'legacy-reuse'].includes(choice.action)) {
      selectedIdentity = { recipeFingerprint: recipe, jobId: choice.jobId };
    }
    selected.set(job.id, { recipeFingerprint: recipe, selectedIdentity });
    const bakes = bakeSpecs(job);
    const bakeConfigFingerprint = hashJson({
      implementations: bakes.map((bake) => config.bakers?.[bake.type] ? functionIdentity(config.bakers[bake.type]) : IMPLEMENTATION_ID),
      bakes,
    });
    const entry = {
      id: job.id,
      engine: job.engine,
      action: choice.action,
      verification: choice.verification,
      jobId: choice.jobId ?? null,
      recipeFingerprint: recipe,
      selectedIdentity,
      executable: { engine: job.engine, mode: job.mode ?? null, params, inputHashes: hashes },
      bakeConfigFingerprint,
      exportConfigFingerprint,
      dependencies,
      recorded,
      baker: bakes.length === 1 ? bakes[0].type : null,
      bakers: bakes.map((bake) => bake.type),
      raw: job.raw || job.id,
      estimatedCredits: null,
      costSource: null,
      explanation: graph.explain(job.id),
      blockReason: choice.blockReason ?? null,
    };
    if (choice.action === 'submit') {
      submissions += 1;
      const cost = job.credits ?? contract?.creditsPerRun;
      if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
        entry.estimatedCredits = cost;
        entry.costSource = job.credits !== undefined ? 'manifest-estimate' : 'contract-snapshot';
        estimatedCredits += cost;
      } else {
        unknownCost += 1;
      }
    }
    jobs.push(entry);
  }

  const frozen = {
    version: EXECUTION_PLAN_VERSION,
    implementation: IMPLEMENTATION_ID,
    jobs: jobs.map(({ explanation, ...entry }) => entry),
    spending: { submissions, estimatedCredits, unknownCost },
  };
  const violations = [];
  const budget = config.budget ?? {};
  if (typeof budget.maxEstimatedCredits === 'number' && estimatedCredits > budget.maxEstimatedCredits) violations.push(`estimated credits ${estimatedCredits} exceed budget ${budget.maxEstimatedCredits}`);
  if (Number.isInteger(budget.maxSubmissions) && submissions > budget.maxSubmissions) violations.push(`new submissions ${submissions} exceed budget ${budget.maxSubmissions}`);
  if (unknownCost > 0 && config.budget !== undefined && budget.allowUnknownCost !== true) violations.push(`${unknownCost} new job(s) have unknown cost`);
  const withAdmission = { ...frozen, admission: { allowed: violations.length === 0, violations } };
  return { ...withAdmission, fingerprint: hashJson(withAdmission), jobs };
}

export function assertSpendApproved(plan, approvedFingerprint) {
  if (plan.spending.submissions === 0) return;
  if (!plan.admission?.allowed) throw new Error(`plan ${plan.fingerprint} is outside the local budget policy: ${plan.admission.violations.join('; ')}`);
  if (typeof approvedFingerprint !== 'string' || approvedFingerprint !== plan.fingerprint) {
    const cost = plan.spending.unknownCost
      ? `${plan.spending.estimatedCredits} known credits plus ${plan.spending.unknownCost} unknown-cost job(s)`
      : `${plan.spending.estimatedCredits} estimated credits`;
    throw new Error(`plan ${plan.fingerprint} requires explicit spending approval (${plan.spending.submissions} new submission(s), ${cost}); rerun with --approve-spend ${plan.fingerprint}`);
  }
}
