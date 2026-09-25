// Sanitized, dated engine-contract snapshots and a deliberately small JSON
// Schema validator for the request subset Moth publishes per engine.

import fs from 'node:fs';
import path from 'node:path';
import { guessContentType } from './api.mjs';
import { writeFileAtomic } from './publish.mjs';

export const CONTRACT_SNAPSHOT_VERSION = 1;

const clone = (value) => JSON.parse(JSON.stringify(value));

function sanitizedSchema(value) {
  if (Array.isArray(value)) return value.map(sanitizedSchema);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (value.format === 'password' && ['default', 'examples', 'example'].includes(key)) continue;
    out[key] = sanitizedSchema(item);
  }
  if (value.format === 'password') out.sensitive = true;
  return out;
}

export function sanitizeEngineContract(engine) {
  if (!engine || typeof engine.engine_id !== 'string') throw new TypeError('engine contract needs engine_id');
  return clone({
    engineId: engine.engine_id,
    name: engine.name ?? null,
    version: engine.version ?? null,
    creditsPerRun: Number.isFinite(engine.credits_per_run) ? engine.credits_per_run : null,
    enabled: engine.enabled ?? null,
    paramsSchema: sanitizedSchema(engine.params_schema ?? {}),
    inputFiles: engine.input_files ?? [],
    outputFiles: engine.output_files ?? [],
    runPolicy: engine.run_policy ?? null,
    errorCodes: engine.error_codes ?? [],
  });
}

export function createContractSnapshot(engines, options = {}) {
  if (!Array.isArray(engines)) throw new TypeError('contract snapshot needs an engine array');
  const table = {};
  for (const raw of engines) {
    const engine = sanitizeEngineContract(raw);
    if (table[engine.engineId]) throw new Error(`duplicate engine contract "${engine.engineId}"`);
    table[engine.engineId] = engine;
  }
  return {
    version: CONTRACT_SNAPSHOT_VERSION,
    service: {
      apiVersion: options.apiVersion ?? null,
      retrievedAt: options.retrievedAt ?? new Date().toISOString(),
      source: options.source ?? 'https://api.mothquantum.com/api/v1/engines',
      verification: options.verification ?? 'observed-read-only',
    },
    engines: table,
  };
}

export function writeContractSnapshot(file, snapshot) {
  validateContractSnapshot(snapshot);
  writeFileAtomic(file, `${JSON.stringify(snapshot, null, 2)}\n`);
}

export function validateContractSnapshot(snapshot) {
  if (!snapshot || snapshot.version !== CONTRACT_SNAPSHOT_VERSION || !snapshot.service || !snapshot.engines || Array.isArray(snapshot.engines)) throw new Error('invalid engine contract snapshot');
  for (const [id, engine] of Object.entries(snapshot.engines)) if (sanitizeEngineContract({
    engine_id: engine.engineId,
    name: engine.name,
    version: engine.version,
    credits_per_run: engine.creditsPerRun,
    enabled: engine.enabled,
    params_schema: engine.paramsSchema,
    input_files: engine.inputFiles,
    output_files: engine.outputFiles,
    run_policy: engine.runPolicy,
    error_codes: engine.errorCodes,
  }).engineId !== id) throw new Error(`engine contract key mismatch: ${id}`);
  return snapshot;
}

export function loadContractSnapshot(file) {
  try { return validateContractSnapshot(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch (error) { throw new Error(`${file}: invalid contract snapshot: ${error.message}`); }
}

function typeMatches(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function checkSchema(value, schema, at, errors) {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema.allOf)) for (const branch of schema.allOf) checkSchema(value, branch, at, errors);
  if (Array.isArray(schema.anyOf)) {
    const matches = schema.anyOf.filter((branch) => { const trial = []; checkSchema(value, branch, at, trial); return trial.length === 0; }).length;
    if (matches === 0) errors.push({ path: at, message: 'does not match any allowed schema' });
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((branch) => { const trial = []; checkSchema(value, branch, at, trial); return trial.length === 0; }).length;
    if (matches !== 1) errors.push({ path: at, message: `must match exactly one schema (matched ${matches})` });
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some((type) => typeMatches(value, type))) { errors.push({ path: at, message: `expected ${types.join(' or ')}` }); return; }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) errors.push({ path: at, message: `expected one of ${schema.enum.map(JSON.stringify).join(', ')}` });
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push({ path: at, message: `expected number >= ${schema.minimum}` });
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push({ path: at, message: `expected number <= ${schema.maximum}` });
  }
  if (typeof value === 'string' && schema.pattern) {
    try { if (!new RegExp(schema.pattern).test(value)) errors.push({ path: at, message: `does not match ${schema.pattern}` }); }
    catch { errors.push({ path: at, message: 'contract contains an invalid pattern' }); }
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, index) => checkSchema(item, schema.items, `${at}[${index}]`, errors));
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) if (!Object.hasOwn(value, required)) errors.push({ path: `${at}.${required}`, message: 'is required by engine contract' });
    for (const [key, item] of Object.entries(value)) {
      if (properties[key]) checkSchema(item, properties[key], `${at}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push({ path: `${at}.${key}`, message: 'additional property is not allowed by engine contract' });
    }
  }
}

export function validateJobsAgainstContracts(config, snapshot, configDir = process.cwd()) {
  validateContractSnapshot(snapshot);
  const errors = [];
  const warnings = [];
  for (const [index, job] of (config.jobs ?? []).entries()) {
    const at = `jobs[${index}]`;
    const contract = snapshot.engines[job.engine];
    if (!contract) { warnings.push({ path: `${at}.engine`, message: `engine "${job.engine}" is absent from the ${snapshot.service.verification} contract snapshot` }); continue; }
    if (contract.enabled === false) errors.push({ path: `${at}.engine`, message: 'engine is disabled in the contract snapshot' });
    if (job.engineVersion && contract.version && job.engineVersion !== contract.version) errors.push({ path: `${at}.engineVersion`, message: `expected engine version ${contract.version}` });
    checkSchema(job.params ?? {}, contract.paramsSchema ?? {}, `${at}.params`, errors);
    const supplied = { ...(job.inputs ?? job.input ?? {}), ...(job.inputFrom ?? {}) };
    const slots = new Map((contract.inputFiles ?? []).map((slot) => [slot.name, slot]));
    for (const slot of contract.inputFiles ?? []) if (slot.required && !Object.hasOwn(supplied, slot.name)) errors.push({ path: `${at}.inputs.${slot.name}`, message: 'required engine input is missing' });
    for (const [slot, relative] of Object.entries(job.inputs ?? job.input ?? {})) {
      if (!slots.has(slot)) { errors.push({ path: `${at}.inputs.${slot}`, message: 'unknown engine input slot' }); continue; }
      const accepted = slots.get(slot).mime_types ?? [];
      const actual = guessContentType(path.resolve(configDir, relative));
      if (accepted.length && !accepted.includes(actual)) errors.push({ path: `${at}.inputs.${slot}`, message: `content type ${actual} is not accepted (${accepted.join(', ')})` });
    }
    for (const slot of Object.keys(job.inputFrom ?? {})) if (!slots.has(slot)) errors.push({ path: `${at}.inputFrom.${slot}`, message: 'unknown engine input slot' });
    if (contract.creditsPerRun === null) warnings.push({ path: `${at}.credits`, message: 'engine cost is unknown in the contract snapshot' });
    else if (job.credits !== undefined && job.credits !== contract.creditsPerRun) warnings.push({ path: `${at}.credits`, message: `manifest estimate ${job.credits} differs from snapshot cost ${contract.creditsPerRun}` });
  }
  return { errors, warnings };
}
