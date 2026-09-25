// Config loading and validation.
//
// A config is either `mothbake.json` or `mothbake.config.mjs` (default export
// or named `config` export):
//
//   {
//     version: 1,                  // optional, recorded in bundles
//     baseUrl: 'https://...',      // optional, MOTH_API_BASE and --base win
//     jobs: [ ... ],               // required
//     sources: { ... },            // optional, for `mothbake sources`
//     emitter: { type: 'esm', ... } // optional; default is { type: 'files' }
//     emitters: [ ... ],           // optional multi-emitter alternative
//     bakers: { ... },             // optional custom baker functions (mjs only)
//     generators: { ... },         // optional custom value generators (mjs only)
//   }

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bakerTypes } from './bakers/index.mjs';
import { emitterTypes } from './emitters/index.mjs';
import { assertDestinationPath } from './emitters/files.mjs';
import { generatorTypes } from './values.mjs';

export const DEFAULT_CONFIG_FILES = ['mothbake.config.mjs', 'mothbake.config.js', 'mothbake.json'];

const CONFIG_KEYS = new Set([
  'version',
  'generator',
  'baseUrl',
  'contractSnapshot',
  'jobs',
  'sources',
  'emitter',
  'emitters',
  'bakers',
  'generators',
  'writeBack',
  'budget',
  'comment',
]);

const JOB_KEYS = new Set([
  'id',
  'engine',
  'engineVersion',
  'enabled',
  'jobId',
  'credits',
  'mode',
  'params',
  'input',
  'inputs',
  'inputFrom',
  'assetIds',
  'generateValues',
  'raw',
  'bake',
  'bakes',
  'recorded',
  'comment',
]);

export class ConfigError extends Error {
  constructor(issues, options = {}) {
    const lines = issues.map(formatIssue);
    super(`invalid config${options.file ? ` (${options.file})` : ''}:\n${lines.map((line) => `  - ${line}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export function formatIssue(issue) {
  return issue.path ? `${issue.path}: ${issue.message}` : issue.message;
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Find the default config file in a directory, or null. */
export function findConfigFile(cwd = process.cwd()) {
  for (const name of DEFAULT_CONFIG_FILES) {
    const candidate = path.join(cwd, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Load a config file. JSON files are parsed; `.mjs`/`.js` files are imported
 * and must default-export (or export `config`) an object.
 *
 * @returns {Promise<{ config: object, file: string, dir: string, format: 'json'|'module' }>}
 */
export async function loadConfig(options = {}) {
  const { file, cwd = process.cwd() } = options;
  const target = file ? path.resolve(cwd, file) : findConfigFile(cwd);
  if (!target) {
    throw new Error(`no config found in ${cwd} (looked for ${DEFAULT_CONFIG_FILES.join(', ')}). Create one or pass --config <file>.`);
  }
  if (!fs.existsSync(target)) throw new Error(`config not found: ${target}`);
  const extension = path.extname(target).toLowerCase();
  if (extension === '.json') {
    const text = fs.readFileSync(target, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`${target}: invalid JSON: ${error.message}`);
    }
    if (!isPlainObject(parsed)) throw new Error(`${target}: config must be a JSON object`);
    return { config: parsed, file: target, dir: path.dirname(target), format: 'json' };
  }
  let module;
  try {
    module = await import(`${pathToFileURL(target).href}?mtime=${fs.statSync(target).mtimeMs}`);
  } catch (error) {
    throw new Error(`${target}: failed to import: ${error.message}`);
  }
  const config = module.default ?? module.config;
  if (!isPlainObject(config)) {
    throw new Error(`${target}: default export must be a config object`);
  }
  return { config, file: target, dir: path.dirname(target), format: 'module' };
}

const STRING_BAKE_KEYS = ['name', 'bucket', 'slot', 'tapsSlot', 'irSlot', 'file', 'reflectance', 'transmittance', 'url', 'urlBase', 'ramp', 'tint', 'effect', 'sampleFormat', 'resampleQuality', 'resample', 'sourceProjection', 'units', 'coordinateConvention', 'category'];
const INTEGER_BAKE_KEYS = ['size', 'width', 'height', 'index', 'maxNotes', 'maxTaps', 'hexChars', 'maxMeasurements', 'maxWidth', 'maxChannels'];
const NUMBER_BAKE_KEYS = ['fps', 'strength', 'transpose', 'threshold', 'pad', 'peak', 'loopStart', 'loopEnd', 'loopSearch', 'loopWindow', 'loopThreshold', 'loopCrossfade', 'targetSampleRate', 'maxSeconds', 'crossfadeMs'];
const BOOLEAN_BAKE_KEYS = ['powerOfTwo', 'dedupe', 'trim', 'normalize', 'mixdown', 'embed', 'detectLoop', 'includeZ'];
const ARRAY_BAKE_KEYS = ['slots', 'order', 'gains', 'axes'];
const OBJECT_BAKE_KEYS = ['ramps', 'meta'];
const KNOWN_BAKE_KEYS = new Set(['type', ...STRING_BAKE_KEYS, ...INTEGER_BAKE_KEYS, ...NUMBER_BAKE_KEYS, ...BOOLEAN_BAKE_KEYS, ...ARRAY_BAKE_KEYS, ...OBJECT_BAKE_KEYS]);

function validateBake(bake, at, context) {
  const { error, warn } = context;
  if (!isPlainObject(bake)) {
    error(at, 'bake must be an object');
    return;
  }
  if (typeof bake.type !== 'string' || !bake.type) {
    error(`${at}.type`, 'bake.type must be a non-empty string');
  } else if (!context.bakers.includes(bake.type)) {
    error(`${at}.type`, `unknown baker "${bake.type}" (available: ${context.bakers.join(', ')})`);
  }
  for (const key of STRING_BAKE_KEYS) {
    if (bake[key] !== undefined && typeof bake[key] !== 'string') error(`${at}.${key}`, `bake.${key} must be a string`);
  }
  for (const key of INTEGER_BAKE_KEYS) {
    if (bake[key] === undefined) continue;
    if (!Number.isInteger(bake[key]) || bake[key] < 0 || (['size', 'width', 'height', 'maxWidth', 'maxChannels'].includes(key) && bake[key] === 0)) {
      error(`${at}.${key}`, `bake.${key} must be a positive integer`);
    }
  }
  for (const key of NUMBER_BAKE_KEYS) {
    if (bake[key] !== undefined && (typeof bake[key] !== 'number' || !Number.isFinite(bake[key]))) {
      error(`${at}.${key}`, `bake.${key} must be a number`);
    }
  }
  for (const key of BOOLEAN_BAKE_KEYS) {
    if (bake[key] !== undefined && typeof bake[key] !== 'boolean') {
      error(`${at}.${key}`, `bake.${key} must be a boolean`);
    }
  }
  for (const key of ARRAY_BAKE_KEYS) {
    if (bake[key] !== undefined && !Array.isArray(bake[key])) error(`${at}.${key}`, `bake.${key} must be an array`);
  }
  if (bake.ramps !== undefined && !isPlainObject(bake.ramps)) error(`${at}.ramps`, 'bake.ramps must be an object of colour ramps');
  if (bake.meta !== undefined && !isPlainObject(bake.meta)) error(`${at}.meta`, 'bake.meta must be an object');
  if (bake.resampleQuality !== undefined && !['preview', 'production'].includes(bake.resampleQuality)) {
    error(`${at}.resampleQuality`, 'bake.resampleQuality must be "preview" or "production"');
  }
  if (bake.resample !== undefined && !['nearest', 'bilinear'].includes(bake.resample)) error(`${at}.resample`, 'bake.resample must be "nearest" or "bilinear"');
  if (bake.sourceProjection !== undefined && bake.sourceProjection !== 'equirectangular') error(`${at}.sourceProjection`, 'only equirectangular sourceProjection is currently supported');
  if (bake.category !== undefined && !['impact', 'ui', 'loop', 'ambience', 'impulse-response', 'generic'].includes(bake.category)) error(`${at}.category`, 'unsupported audio category');
  for (const key of Object.keys(bake)) {
    if (KNOWN_BAKE_KEYS.has(key)) continue;
    warn(`${at}.${key}`, `unknown bake option "${key}" (custom bakers may accept their own options)`);
  }
}

function validateJob(job, at, context) {
  const { error, warn } = context;
  if (!isPlainObject(job)) {
    error(at, 'job must be an object');
    return;
  }
  const id = job.id;
  if (typeof id !== 'string' || !id.trim()) {
    error(`${at}.id`, 'id must be a non-empty string');
  } else if (context.ids.has(id)) {
    error(`${at}.id`, `duplicate job id "${id}" (first defined at ${context.ids.get(id)})`);
  } else {
    context.ids.set(id, at);
  }
  const label = typeof id === 'string' && id ? ` ("${id}")` : '';
  if (typeof job.engine !== 'string' || !job.engine.trim()) error(`${at}.engine`, `engine must be a non-empty string${label}`);
  if (job.engineVersion !== undefined && (typeof job.engineVersion !== 'string' || !job.engineVersion)) error(`${at}.engineVersion`, `engineVersion must be a non-empty string${label}`);
  if (job.enabled !== undefined && typeof job.enabled !== 'boolean') error(`${at}.enabled`, `enabled must be a boolean${label}`);
  if (job.jobId !== undefined && (typeof job.jobId !== 'string' || !job.jobId)) error(`${at}.jobId`, `jobId must be a non-empty string${label}`);
  if (job.credits !== undefined && (typeof job.credits !== 'number' || !Number.isFinite(job.credits) || job.credits < 0)) error(`${at}.credits`, `credits must be a non-negative number${label}`);
  if (job.params !== undefined && !isPlainObject(job.params)) error(`${at}.params`, `params must be an object${label}`);
  if (job.mode !== undefined && (typeof job.mode !== 'string' || !job.mode)) error(`${at}.mode`, `mode must be a non-empty string${label}`);
  if (job.mode !== undefined && isPlainObject(job.params) && job.params.mode !== undefined) {
    error(at, `set execution mode in job.mode or params.mode, not both${label}`);
  }
  if (job.raw !== undefined && (typeof job.raw !== 'string' || !job.raw)) error(`${at}.raw`, `raw must be a non-empty string${label}`);
  if (job.input !== undefined && job.inputs !== undefined) warn(at, 'both "input" and "inputs" are present; "inputs" wins');
  const inputs = job.inputs ?? job.input;
  if (inputs !== undefined) {
    if (!isPlainObject(inputs)) error(`${at}.inputs`, `inputs must be an object of { slot: path }${label}`);
    else {
      for (const [slot, value] of Object.entries(inputs)) {
        if (typeof value !== 'string' || !value) error(`${at}.inputs.${slot}`, `input path must be a non-empty string${label}`);
      }
    }
  }
  if (job.inputFrom !== undefined) {
    if (!isPlainObject(job.inputFrom)) {
      error(`${at}.inputFrom`, `inputFrom must map input slots to { job, slot }${label}`);
    } else {
      for (const [slot, ref] of Object.entries(job.inputFrom)) {
        const atRef = `${at}.inputFrom.${slot}`;
        if (typeof ref === 'string') {
          if (!/^[^/:]+\/[^/]+$/.test(ref)) error(atRef, `inputFrom shorthand must be "job/slot"${label}`);
          continue;
        }
        if (!isPlainObject(ref)) {
          error(atRef, `inputFrom entry must be { job, slot } or "job/slot"${label}`);
          continue;
        }
        if (typeof ref.job !== 'string' || !ref.job) error(`${atRef}.job`, `inputFrom.job must be a non-empty job id${label}`);
        if (ref.slot !== undefined && (typeof ref.slot !== 'string' || !ref.slot)) error(`${atRef}.slot`, `inputFrom.slot must be a non-empty slot name${label}`);
      }
    }
  }
  if (job.assetIds !== undefined) {
    if (!isPlainObject(job.assetIds)) error(`${at}.assetIds`, `assetIds must be an object of { slot: assetId }${label}`);
    else {
      for (const [slot, value] of Object.entries(job.assetIds)) {
        if (typeof value !== 'string' || !value) error(`${at}.assetIds.${slot}`, `asset id must be a non-empty string${label}`);
      }
    }
  }
  if (job.generateValues !== undefined) {
    if (!isPlainObject(job.generateValues) || typeof job.generateValues.type !== 'string') {
      error(`${at}.generateValues`, `generateValues must be an object with a type${label}`);
    } else if (!context.generators.includes(job.generateValues.type)) {
      error(`${at}.generateValues.type`, `unknown generator "${job.generateValues.type}" (available: ${context.generators.join(', ')})`);
    }
  }
  if (job.bake !== undefined && job.bakes !== undefined) error(at, `use bake or bakes, not both${label}`);
  if (job.bake !== undefined) validateBake(job.bake, `${at}.bake`, context);
  if (job.bakes !== undefined) {
    if (!Array.isArray(job.bakes) || !job.bakes.length) error(`${at}.bakes`, `bakes must be a non-empty array${label}`);
    else job.bakes.forEach((bake, bakeIndex) => validateBake(bake, `${at}.bakes[${bakeIndex}]`, context));
  }
  if (job.recorded !== undefined) {
    if (!isPlainObject(job.recorded)) {
      error(`${at}.recorded`, `recorded must be an object with outputs/result${label}`);
    } else {
      if (job.recorded.outputs !== undefined) {
        if (!isPlainObject(job.recorded.outputs)) error(`${at}.recorded.outputs`, `recorded.outputs must map slots to file paths${label}`);
        else {
          for (const [slot, value] of Object.entries(job.recorded.outputs)) {
            if (typeof value !== 'string' || !value) error(`${at}.recorded.outputs.${slot}`, `recorded output path must be a non-empty string${label}`);
          }
        }
      }
      if (job.recorded.result !== undefined && typeof job.recorded.result !== 'string' && !isPlainObject(job.recorded.result) && !Array.isArray(job.recorded.result)) {
        error(`${at}.recorded.result`, `recorded.result must be a JSON file path or an inline value${label}`);
      }
      if (job.recorded.outputs === undefined && job.recorded.result === undefined) {
        error(`${at}.recorded`, `recorded needs at least one of outputs or result${label}`);
      }
    }
  }
  for (const key of Object.keys(job)) {
    if (!JOB_KEYS.has(key)) warn(`${at}.${key}`, `unknown job key "${key}"`);
  }
}

function validateSources(sources, at, context) {
  const { error } = context;
  if (sources === undefined || sources === null || sources === true || sources === false) return;
  if (!isPlainObject(sources)) {
    error(at, 'sources must be an object');
    return;
  }
  if (sources.dir !== undefined && (typeof sources.dir !== 'string' || !sources.dir)) error(`${at}.dir`, 'sources.dir must be a non-empty string');
  if (sources.only !== undefined && (!Array.isArray(sources.only) || sources.only.some((name) => typeof name !== 'string'))) {
    error(`${at}.only`, 'sources.only must be an array of pattern names');
  }
  if (sources.patterns !== undefined && !isPlainObject(sources.patterns)) {
    error(`${at}.patterns`, 'sources.patterns must be an object of pattern specs');
  } else if (isPlainObject(sources.patterns)) {
    for (const [name, spec] of Object.entries(sources.patterns)) {
      if (!isPlainObject(spec)) error(`${at}.patterns.${name}`, 'pattern spec must be an object');
    }
  }
  if (sources.audio !== undefined && !isPlainObject(sources.audio)) {
    error(`${at}.audio`, 'sources.audio must be an object of audio specs');
  } else if (isPlainObject(sources.audio)) {
    for (const [name, spec] of Object.entries(sources.audio)) {
      if (!isPlainObject(spec)) error(`${at}.audio.${name}`, 'audio spec must be an object');
    }
  }
  if (sources.chunks !== undefined && sources.chunks !== null && sources.chunks !== false) {
    if (!isPlainObject(sources.chunks)) error(`${at}.chunks`, 'sources.chunks must be false or an object');
    else if (typeof sources.chunks.from !== 'string' || !sources.chunks.from) error(`${at}.chunks.from`, 'sources.chunks.from must name an audio source');
  }
  if (sources.motif !== undefined && sources.motif !== false) {
    if (!isPlainObject(sources.motif)) error(`${at}.motif`, 'sources.motif must be false or an object of MIDI options');
    else if (sources.motif.notes !== undefined && !Array.isArray(sources.motif.notes)) error(`${at}.motif.notes`, 'motif notes must be an array');
  }
}

function validateEmitters(config, context) {
  const { error } = context;
  const spec = config.emitters ?? (config.emitter !== undefined ? [config.emitter] : undefined);
  if (spec === undefined) return;
  if (!Array.isArray(spec)) {
    error('emitters', 'emitters must be an array (or use `emitter` for a single emitter)');
    return;
  }
  spec.forEach((raw, index) => {
    const at = `emitters[${index}]`;
    if (typeof raw === 'function') return;
    if (typeof raw === 'string') {
      if (!emitterTypes.includes(raw)) error(at, `unknown emitter "${raw}" (available: ${emitterTypes.join(', ')})`);
      return;
    }
    if (!isPlainObject(raw)) {
      error(at, 'emitter must be a name, an object, or an emit function');
      return;
    }
    if (typeof raw.emit === 'function') return;
    if (typeof raw.type !== 'string' || !raw.type) {
      error(`${at}.type`, 'emitter type must be a non-empty string');
    } else if (!emitterTypes.includes(raw.type)) {
      error(`${at}.type`, `unknown emitter "${raw.type}" (available: ${emitterTypes.join(', ')})`);
    }
    if (raw.file !== undefined && (typeof raw.file !== 'string' || !raw.file)) error(`${at}.file`, 'emitter file must be a non-empty string');
    if (['files', 'audio-pack', 'audio-pack-versioned'].includes(raw.type)) {
      for (const [key, directory] of [['dir', true], ['indexFile', false], ['manifest', false]]) {
        if (raw[key] === undefined || (key === 'manifest' && raw[key] === false)) continue;
        if (key === 'indexFile' && raw.type !== 'files') continue;
        if (key === 'manifest' && raw.type === 'files') continue;
        try { assertDestinationPath(raw[key], `${at}.${key}`, { directory }); }
        catch (cause) { error(`${at}.${key}`, cause.message); }
      }
      if (raw.type === 'audio-pack-versioned') {
        if (raw.merge) error(`${at}.merge`, 'versioned audio pack requires complete records (merge is unsupported)');
        if (raw.manifest !== undefined && raw.manifest !== 'manifest.json') error(`${at}.manifest`, 'versioned audio pack requires manifest.json');
        if (raw.versionId !== undefined && (typeof raw.versionId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(raw.versionId))) error(`${at}.versionId`, 'invalid pack version id');
      }
    }
    if (raw.export !== undefined && typeof raw.export !== 'string') error(`${at}.export`, 'emitter export must be a string');
    if (raw.shape !== undefined && !['buckets', 'records'].includes(raw.shape)) error(`${at}.shape`, 'emitter shape must be "buckets" or "records"');
  });
}

/**
 * Validate a config object. Returns `{ errors, warnings }` where every issue is
 * `{ path, message }`; callers can throw a ConfigError with the same list.
 */
export function validateConfig(config, options = {}) {
  const errors = [];
  const warnings = [];
  const context = {
    ids: new Map(),
    bakers: options.bakers ?? bakerTypes,
    emitters: options.emitters ?? emitterTypes,
    generators: options.generators ?? generatorTypes,
    error: (issuePath, message) => errors.push({ path: issuePath, message }),
    warn: (issuePath, message) => warnings.push({ path: issuePath, message }),
  };
  if (!isPlainObject(config)) {
    context.error('', 'config must be an object');
    return { errors, warnings };
  }
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) context.warn(key, `unknown top-level key "${key}"`);
  }
  if (config.version !== undefined && (typeof config.version !== 'number' || !Number.isFinite(config.version))) {
    context.error('version', 'version must be a number');
  }
  if (config.generator !== undefined && (typeof config.generator !== 'string' || !config.generator)) {
    context.error('generator', 'generator must be a non-empty string');
  }
  if (config.baseUrl !== undefined && (typeof config.baseUrl !== 'string' || !config.baseUrl)) {
    context.error('baseUrl', 'baseUrl must be a non-empty string');
  }
  if (config.contractSnapshot !== undefined && (typeof config.contractSnapshot !== 'string' || !config.contractSnapshot)) context.error('contractSnapshot', 'contractSnapshot must be a non-empty path');
  if (config.writeBack !== undefined && typeof config.writeBack !== 'boolean') {
    context.error('writeBack', 'writeBack must be a boolean');
  }
  if (config.budget !== undefined) {
    if (!isPlainObject(config.budget)) context.error('budget', 'budget must be an object');
    else {
      for (const key of Object.keys(config.budget)) if (!['maxEstimatedCredits', 'maxSubmissions', 'allowUnknownCost'].includes(key)) context.warn(`budget.${key}`, `unknown budget option "${key}"`);
      if (config.budget.maxEstimatedCredits !== undefined && (typeof config.budget.maxEstimatedCredits !== 'number' || !Number.isFinite(config.budget.maxEstimatedCredits) || config.budget.maxEstimatedCredits < 0)) context.error('budget.maxEstimatedCredits', 'must be a non-negative number');
      if (config.budget.maxSubmissions !== undefined && (!Number.isInteger(config.budget.maxSubmissions) || config.budget.maxSubmissions < 0)) context.error('budget.maxSubmissions', 'must be a non-negative integer');
      if (config.budget.allowUnknownCost !== undefined && typeof config.budget.allowUnknownCost !== 'boolean') context.error('budget.allowUnknownCost', 'must be boolean');
    }
  }
  if (!Array.isArray(config.jobs)) {
    context.error('jobs', 'jobs must be an array');
  } else {
    config.jobs.forEach((job, index) => validateJob(job, `jobs[${index}]`, context));
    // `inputFrom` is a dependency edge. The execution planner topologically
    // orders forward references; only missing references are invalid here.
    const positions = new Map(config.jobs.map((job, index) => [job?.id, index]));
    config.jobs.forEach((job, index) => {
      if (!isPlainObject(job?.inputFrom)) return;
      for (const [slot, ref] of Object.entries(job.inputFrom)) {
        const refJob = typeof ref === 'string' ? ref.split('/')[0] : ref?.job;
        if (typeof refJob !== 'string' || !refJob) continue;
        if (!positions.has(refJob)) {
          context.error(`jobs[${index}].inputFrom.${slot}.job`, `unknown job "${refJob}"`);
        }
      }
    });
  }
  if (config.bakers !== undefined) {
    if (!isPlainObject(config.bakers)) context.error('bakers', 'bakers must be an object of functions');
    else {
      for (const [name, fn] of Object.entries(config.bakers)) {
        if (typeof fn !== 'function') context.error(`bakers.${name}`, 'custom baker must be a function');
      }
    }
  }
  if (config.generators !== undefined) {
    if (!isPlainObject(config.generators)) context.error('generators', 'generators must be an object of functions');
    else {
      for (const [name, fn] of Object.entries(config.generators)) {
        if (typeof fn !== 'function') context.error(`generators.${name}`, 'custom generator must be a function');
      }
    }
  }
  validateSources(config.sources, 'sources', context);
  validateEmitters(config, context);
  // Custom registries widen the known type list for the fields above.
  return { errors, warnings };
}

/** Validate and throw a ConfigError when there is at least one error. */
export function assertValidConfig(config, options = {}) {
  const { errors } = validateConfig(config, options);
  if (errors.length) throw new ConfigError(errors, { file: options.file });
  return config;
}
