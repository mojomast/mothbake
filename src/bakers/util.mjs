// Shared helpers for bakers. A baker receives `(job, ctx)` and returns a
// portable record fragment: `{ bucket, key, value, merge?, index?, fps? }`.
// The runner stamps `job` and `type` on it and feeds the records to emitters.

import { toBase64 } from '../image.mjs';

/** Fetch a required output slot or fail with the slots that do exist. */
export function requireFile(ctx, slot, label) {
  const file = ctx.files.get(slot);
  if (!file) {
    const available = [...ctx.files.keys()].join(', ') || 'none';
    throw new Error(`${label}: output slot "${slot}" missing (available: ${available})`);
  }
  return file;
}

export function positiveInt(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer (got ${JSON.stringify(value)})`);
  return value;
}

export function positiveNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number (got ${JSON.stringify(value)})`);
  }
  return value;
}

/** Portable image payload: base64 pixels plus the metadata needed to decode. */
export function imageValue(bytes, width, height, format = 'rgba8') {
  return { width, height, format, data: toBase64(bytes) };
}

/**
 * Unwrap an engine result to its payload. Live results arrive as
 * `{ outputs, result }`; recorded fixtures hold the inline `result` value
 * directly, and some engines return `{ output: ... }` inside it.
 */
export function outputOf(result) {
  if (result === null || result === undefined) return null;
  if (result.result !== undefined) return result.result?.output ?? result.result;
  if (result.output !== undefined) return result.output;
  return result;
}

/** Extract a 2D numeric grid from an engine result, or null. */
export function gridOf(result) {
  const output = outputOf(result);
  return Array.isArray(output) ? output : null;
}
