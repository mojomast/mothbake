// Declarative, bounded variation planning. This module resolves every choice
// before execution; it performs no media processing and contains no implicit
// cloud fallback.

import { hashJson } from './identity.mjs';

export const VARIATION_PLAN_VERSION = 1;
export const MAX_VARIATIONS = 64;
const plain = (value) => value && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function scalar(value, label) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new TypeError(`${label} must be a finite number, string, boolean or null`);
}

function choices(name, spec) {
  if (!plain(spec)) throw new TypeError(`variation parameter "${name}" must be an object`);
  if (Array.isArray(spec.values)) {
    if (!spec.values.length) throw new TypeError(`variation parameter "${name}" values cannot be empty`);
    return [...new Map(spec.values.map((value) => [JSON.stringify(scalar(value, `${name}.values`)), value])).values()];
  }
  const { min, max, steps } = spec;
  if (![min, max].every((value) => typeof value === 'number' && Number.isFinite(value))
    || !Number.isInteger(steps) || steps < 2 || steps > MAX_VARIATIONS || min > max) {
    throw new TypeError(`variation parameter "${name}" needs values[] or finite min/max with steps 2..${MAX_VARIATIONS}`);
  }
  return Array.from({ length: steps }, (_, index) => {
    const value = index === steps - 1 ? max : min + ((max - min) * index) / (steps - 1);
    return Number(value.toPrecision(15));
  });
}

function allowed(params, constraints = []) {
  for (const [index, constraint] of constraints.entries()) {
    if (!plain(constraint) || typeof constraint.left !== 'string' || !['<', '<=', '==', '>=', '>'].includes(constraint.op)
      || (!Object.hasOwn(constraint, 'value') && typeof constraint.right !== 'string')) {
      throw new TypeError(`constraint[${index}] must define left, op, and value or right`);
    }
    const left = params[constraint.left];
    const right = Object.hasOwn(constraint, 'value') ? constraint.value : params[constraint.right];
    const passes = constraint.op === '<' ? left < right
      : constraint.op === '<=' ? left <= right
        : constraint.op === '==' ? left === right
          : constraint.op === '>=' ? left >= right : left > right;
    if (!passes) return false;
  }
  return true;
}

function deltaFrom(baseline, params) {
  const delta = {};
  for (const key of Object.keys(params).sort()) if (!Object.is(params[key], baseline[key])) delta[key] = params[key];
  return delta;
}

/** Resolve a bounded Cartesian variation request into exact candidates. */
export function resolveVariationPlan(request) {
  if (!plain(request) || request.version !== 1 || typeof request.baselineId !== 'string' || !request.baselineId
    || !plain(request.baselineParams) || !plain(request.parameters)) throw new TypeError('invalid variation request v1');
  const names = Object.keys(request.parameters).sort();
  if (!names.length) throw new TypeError('variation request needs at least one parameter');
  const resolved = names.map((name) => [name, choices(name, request.parameters[name])]);
  let combinations = 1;
  for (const [, values] of resolved) {
    combinations *= values.length;
    if (!Number.isSafeInteger(combinations) || combinations > 100_000) throw new Error('variation search space exceeds 100000 combinations');
  }
  const candidates = [];
  function walk(index, params) {
    if (index === resolved.length) {
      const complete = { ...request.baselineParams, ...params };
      if (allowed(complete, request.constraints ?? [])) candidates.push(complete);
      return;
    }
    const [name, values] = resolved[index];
    for (const value of values) walk(index + 1, { ...params, [name]: value });
  }
  walk(0, {});
  if (!candidates.length) throw new Error('variation constraints reject every candidate');
  const requestedCount = request.count ?? candidates.length;
  if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > MAX_VARIATIONS) {
    throw new TypeError(`variation count must be an integer from 1 to ${MAX_VARIATIONS}`);
  }
  const seed = request.seed ?? 0;
  if (!Number.isSafeInteger(seed)) throw new TypeError('variation seed must be a safe integer');
  // If the bounded request asks for fewer candidates than the full grid, choose
  // a deterministic spread by hash. The chosen exact params are frozen below.
  const selected = candidates.length > requestedCount
    ? candidates.map((params) => ({ params, score: hashJson({ seed, params }) })).sort((a, b) => a.score.localeCompare(b.score)).slice(0, requestedCount).map((entry) => entry.params)
    : candidates;
  if (selected.length > MAX_VARIATIONS) throw new Error(`resolved variation count ${selected.length} exceeds ${MAX_VARIATIONS}; set an explicit count`);
  const planBody = {
    version: VARIATION_PLAN_VERSION,
    baselineId: request.baselineId,
    baselineParams: request.baselineParams,
    seed,
    searchSpace: combinations,
    candidates: selected.map((params, index) => ({
      id: `${request.baselineId}-v${String(index + 1).padStart(2, '0')}`,
      params,
      parameterDelta: deltaFrom(request.baselineParams, params),
    })),
  };
  return { ...planBody, fingerprint: hashJson(planBody) };
}

/** Build a normal variation request centered on a chosen candidate. */
export function refineVariationRequest(candidate, refinements, options = {}) {
  if (!plain(candidate) || typeof candidate.id !== 'string' || !plain(candidate.params) || !plain(refinements)) {
    throw new TypeError('refinement needs a candidate and parameter specs');
  }
  const parameters = {};
  for (const [name, spec] of Object.entries(refinements)) {
    if (!plain(spec) || typeof candidate.params[name] !== 'number' || !Number.isFinite(candidate.params[name])
      || typeof spec.radius !== 'number' || !Number.isFinite(spec.radius) || spec.radius < 0
      || !Number.isInteger(spec.steps) || spec.steps < 2) throw new TypeError(`invalid refinement for "${name}"`);
    const center = candidate.params[name];
    parameters[name] = {
      min: Math.max(spec.min ?? -Infinity, center - spec.radius),
      max: Math.min(spec.max ?? Infinity, center + spec.radius),
      steps: spec.steps,
    };
  }
  return {
    version: 1,
    baselineId: candidate.id,
    baselineParams: structuredClone(candidate.params),
    parameters,
    count: options.count,
    seed: options.seed ?? 0,
    constraints: options.constraints ?? [],
  };
}
