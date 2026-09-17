// Runner: resolve each job's result (recorded fixture, reused job id, or a
// live API submission), save raw outputs, bake portable records, then hand
// them to the configured emitters.
//
// Nothing game-specific lives here: buckets, keys and payload shapes come
// from the bakers the config names.

import fs from 'node:fs';
import path from 'node:path';
import { createApi, resolveBaseUrl } from './api.mjs';
import { resolveBakers } from './bakers/index.mjs';
import { summarizeRecords } from './bundle.mjs';
import { runEmitters } from './emitters/index.mjs';
import { generateValues, generators as builtinGenerators } from './values.mjs';

const CONTENT_TYPE_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/vnd.radiance': 'hdr',
  'application/zip': 'zip',
  'application/json': 'json',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/midi': 'mid',
  'audio/mpeg': 'mp3',
  'application/octet-stream': 'bin',
};

const sanitize = (name) => String(name).replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();

function extensionFor(contentType, url) {
  if (contentType && CONTENT_TYPE_EXTENSIONS[contentType]) return CONTENT_TYPE_EXTENSIONS[contentType];
  const fromUrl = path.extname(new URL(url, 'https://example.invalid').pathname).replace(/^\./, '');
  if (fromUrl && /^[a-z0-9]{1,8}$/i.test(fromUrl)) return fromUrl;
  return 'bin';
}

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
  const known = new Set(jobs.map((job) => job.id));
  const missing = [...set].filter((id) => !known.has(id));
  if (missing.length) {
    throw new Error(`--only did not match any job: ${missing.join(', ')} (known ids: ${jobs.map((job) => job.id).join(', ')})`);
  }
  return jobs.filter((job) => set.has(job.id));
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

async function resolveLiveResult({ api, job, inputs, configDir, force, log, generatorRegistry }) {
  if (job.jobId && !force) {
    log(`  reusing job ${job.jobId}`);
    try {
      const status = await api.jobStatus(job.jobId);
      if (status?.status === 'completed') return api.jobResult(job.jobId);
      log(`  recorded job is ${status?.status ?? 'unknown'}; submitting a fresh one`);
    } catch (error) {
      log(`  could not reuse job ${job.jobId}: ${error.message}; submitting a fresh one`);
    }
  }
  const inputEntries = Object.entries(inputs);
  let inputFiles;
  if (inputEntries.length) {
    inputFiles = {};
    for (const [slot, relative] of inputEntries) {
      const file = path.resolve(configDir, relative);
      if (!fs.existsSync(file)) {
        throw new Error(`input "${slot}" not found: ${file} (run "mothbake sources" to generate source art)`);
      }
      inputFiles[slot] = await api.uploadAsset(file);
    }
  }
  const params = { ...(job.params || {}) };
  const generated = generateValues(job, generatorRegistry);
  if (generated) params.values = generated;
  const submitted = await api.submitJob(job.engine, { params, inputFiles, mode: job.mode });
  if (!submitted?.job_id) throw new Error(`submit for "${job.id}" returned no job_id`);
  log(`  submitted ${submitted.job_id}`);
  job.jobId = submitted.job_id;
  await api.waitForJob(submitted.job_id, { log });
  return api.jobResult(submitted.job_id);
}

async function saveResponse({ response, api, outDir, rawName, log }) {
  const files = new Map();
  const saved = new Map();
  const rawDir = path.join(outDir, 'raw', rawName);
  fs.mkdirSync(rawDir, { recursive: true });

  if (response.files) {
    // Recorded fixture: buffers already in memory; keep the fixture's extension.
    for (const [slot, buffer] of response.files) {
      const extension = extensionFor(null, response.sources?.get(slot) ?? slot);
      const relative = path.join('raw', rawName, `${sanitize(slot)}.${extension}`);
      const target = path.join(outDir, relative);
      fs.writeFileSync(target, buffer);
      files.set(slot, buffer);
      saved.set(slot, { file: target, relative, contentType: null });
      log(`  fixture ${path.relative(outDir, target)} (${buffer.length} bytes)`);
    }
  } else {
    for (const output of response.outputs || []) {
      const buffer = output.bufferOverride ?? (await api.downloadOutput(output.url));
      const slot = output.slot || `output-${files.size}`;
      const extension = extensionFor(output.content_type, output.url);
      const relative = path.join('raw', rawName, `${sanitize(slot)}.${extension}`);
      const target = path.join(outDir, relative);
      fs.writeFileSync(target, buffer);
      files.set(slot, buffer);
      saved.set(slot, { file: target, relative, contentType: output.content_type ?? null });
      log(`  saved ${path.relative(outDir, target)} (${buffer.length} bytes)`);
    }
  }
  if (response.result !== undefined && response.result !== null) {
    const relative = path.join('raw', rawName, 'result.json');
    fs.writeFileSync(path.join(outDir, relative), `${JSON.stringify(response.result, null, 2)}\n`);
  }
  return { files, saved, rawDir };
}

function writeBackJobIds({ config, configFile, writeBack, log }) {
  if (writeBack === false || !configFile || path.extname(configFile).toLowerCase() !== '.json') return false;
  const next = `${JSON.stringify(config, null, 2)}\n`;
  if (fs.readFileSync(configFile, 'utf8') === next) return false;
  fs.writeFileSync(configFile, next);
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
 *   strict?: boolean, writeBack?: boolean, log?: (message: string) => void,
 *   fetchImpl?: typeof fetch, sleepImpl?: (ms: number) => Promise<void>,
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

  const jobs = selectJobs(config, only);
  const bakers = resolveBakers(config);
  const generatorRegistry = { ...builtinGenerators, ...(config.generators || {}) };
  const version = config.version ?? 1;
  const generator = config.generator ?? 'mothbake';
  const records = [];
  const provenance = {};
  const failures = [];
  const plan = [];
  let recordedJobIds = false;
  const baseUrl = resolveBaseUrl({ base: options.base, configBaseUrl: config.baseUrl, env });
  const api = dry
    ? null
    : createApi({ baseUrl, key: options.key ?? null, fetchImpl: options.fetchImpl, sleepImpl: options.sleepImpl, log });

  for (const job of jobs) {
    if (job.enabled === false) {
      log(`- ${job.id}: disabled`);
      plan.push({ id: job.id, engine: job.engine, action: 'disabled' });
      continue;
    }
    const rawName = job.raw || job.id;
    const inputs = job.inputs ?? job.input ?? {};
    const bakeType = job.bake?.type ?? null;
    if (dry) {
      const action = job.recorded && !force ? 'recorded' : job.jobId && !force ? 'reuse' : 'submit';
      plan.push({ id: job.id, engine: job.engine, action, baker: bakeType, raw: rawName });
      const what = action === 'recorded' ? 'read the recorded fixture' : action === 'reuse' ? `reuse job ${job.jobId}` : 'submit to the API';
      log(`> ${job.id} (${job.engine}) — would ${what}${bakeType ? `, bake ${bakeType}` : ''}`);
      continue;
    }
    log(`\n> ${job.id} (${job.engine})`);
    try {
      let response;
      if (job.recorded && !force) {
        log('  using recorded fixture');
        response = loadRecorded(job, configDir);
      } else {
        if (!options.key) {
          throw new Error(`MOTH_API_KEY is required to run live job "${job.id}" (set it, or add a "recorded" block for offline runs)`);
        }
        const previousJobId = job.jobId;
        response = await resolveLiveResult({ api, job, inputs, configDir, force, log, generatorRegistry });
        if (job.jobId && job.jobId !== previousJobId) recordedJobIds = true;
      }
      const { files, saved } = await saveResponse({ response, api, outDir, rawName, log });
      if (bakeType) {
        const baker = bakers[bakeType];
        if (!baker) throw new Error(`unknown baker: ${bakeType}`);
        const fragment = baker(job, {
          files,
          saved,
          result: response.result,
          bake: job.bake,
          job,
          rawName,
          outDir,
          configDir,
          log,
        });
        const record = { job: job.id, type: bakeType, ...fragment };
        records.push(record);
        log(`  baked ${record.bucket}.${record.key}${record.merge === 'frames' ? `[${record.index ?? 0}]` : ''}`);
      }
      provenance[job.id] = {
        engine: job.engine,
        jobId: job.jobId || null,
        mode: job.mode || job.params?.mode || 'emu',
        name: job.bake?.name ?? null,
        credits: job.credits ?? null,
      };
      plan.push({ id: job.id, engine: job.engine, action: 'ran', jobId: job.jobId ?? null, baker: bakeType });
    } catch (error) {
      log(`  FAILED: ${error.message}`);
      failures.push({ id: job.id, engine: job.engine, message: error.message });
      if (strict) throw error;
    }
  }

  if (dry) {
    return { dry: true, records, provenance, failures, written: [], plan, buckets: summarizeRecords(records) };
  }

  let written = [];
  if (records.length) {
    written = await runEmitters({ config, records, outDir, provenance, version, generator, log });
  }
  const updatedConfig = recordedJobIds && writeBackJobIds({ config, configFile, writeBack: options.writeBack, log });
  return {
    dry: false,
    records,
    provenance,
    failures,
    written,
    plan,
    buckets: summarizeRecords(records),
    outDir,
    updatedConfig,
  };
}
