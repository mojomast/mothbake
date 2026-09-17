// Shared helpers for bakers. A baker receives `(job, ctx)` and returns a
// portable record fragment: `{ bucket, key, value, merge?, index?, fps? }`.
// The runner stamps `job` and `type` on it and feeds the records to emitters.

import path from 'node:path';
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

const TAP_KEYS = ['taps', 'tap_map', 'ir', 'feedback_taps'];

/**
 * Find the first tap list under a known key, to a bounded depth. Engine
 * envelopes place taps at `extras.taps` (trajectory) or `extras.tap_map.taps`
 * (media) — and sometimes at `data.extras.taps` — so a shallow recursive search
 * is the only robust way to read them, regardless of envelope flavour.
 */
export function tapsFrom(value) {
  const queue = [[value, 0]];
  const seen = new Set();
  while (queue.length) {
    const [node, depth] = queue.shift();
    if (!node || typeof node !== 'object' || depth > 4 || seen.has(node)) continue;
    seen.add(node);
    for (const key of TAP_KEYS) {
      const child = node[key];
      if (Array.isArray(child) && child.length) return child;
    }
    for (const child of Object.values(node)) {
      if (child && typeof child === 'object' && !Array.isArray(child)) queue.push([child, depth + 1]);
    }
  }
  return null;
}

/**
 * Resolve a descriptor URL from `url` (with `{raw}`/`{slot}`/`{file}`
 * placeholders) or `urlBase` plus the saved relative path. Kept here so `ir`,
 * `echo-map` and the audio bakers all use exactly one convention.
 */
export function resolveUrl(options, ctx, slot = 'result') {
  const key = slot ?? '';
  const explicit = typeof options.file === 'string' ? options.file : null;
  const relative = (key ? ctx.saved?.get(key)?.relative ?? null : null) ?? explicit;
  const rawName = ctx.rawName ?? ctx.job?.raw ?? ctx.job?.id;
  if (typeof options.url === 'string') {
    return options.url
      .replaceAll('{raw}', rawName)
      .replaceAll('{slot}', key)
      .replaceAll('{file}', relative ? path.basename(relative) : '');
  }
  if (typeof options.urlBase === 'string' && relative) {
    return `${options.urlBase.replace(/\/+$/, '')}/${rawName}/${path.basename(relative)}`;
  }
  return null;
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
