// echo-map: reduce an engine trajectory/media envelope to a compact tap map.
//
// The envelope may arrive inline (`result`) or as a JSON output slot; taps live
// at `extras.taps` (trajectory), `extras.tap_map.taps` (media) or
// `data.extras.taps`, which the shared recursive extractor handles. The record
// is deliberately small — enough to drive a delay/feedback graph or a synthetic
// reverb — and can point back at the trajectory (`irFile`/`irUrl`) so a later
// job can re-render it without re-measuring.
//
// Options: `slot` (preferred JSON source), `tapsSlot` (default `taps`),
// `irSlot` (slot to link as the trajectory, default `ir` when present),
// `maxTaps` (default 64), `includeZ`, `name`, `bucket` (default `spaces`),
// `url`/`urlBase`, `meta`.

import { requireFile, resolveUrl, tapsFrom } from './util.mjs';

export const type = 'echo-map';
export const defaultBucket = 'spaces';

const round = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : value);

function firstNumber(...values) {
  for (const value of values) if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

function firstString(...values) {
  for (const value of values) if (typeof value === 'string' && value) return value;
  return null;
}

/** Ordered JSON sources to search, deterministic for a given job. */
function candidateSources(ctx, options) {
  const candidates = [];
  const seen = new Set();
  const push = (slot, value, saved) => {
    if (value === undefined || value === null || seen.has(slot)) return;
    seen.add(slot);
    candidates.push({ slot, value, saved: saved ?? ctx.saved?.get(slot) ?? null });
  };
  if (ctx.result !== undefined && ctx.result !== null) push(options.slot ?? 'result', ctx.result, null);
  if (typeof options.slot === 'string') push(options.slot, parseJson(ctx.files.get(options.slot)), ctx.saved?.get(options.slot));
  const preferred = [options.tapsSlot ?? 'taps', 'ir', 'tap_map'];
  for (const slot of preferred) push(slot, parseJson(ctx.files.get(slot)), ctx.saved?.get(slot));
  for (const [slot, buffer] of ctx.files) push(slot, parseJson(buffer), ctx.saved?.get(slot));
  return candidates;
}

function parseJson(buffer) {
  if (!buffer) return undefined;
  if (typeof buffer === 'object' && !Buffer.isBuffer(buffer)) return buffer;
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return undefined;
  }
}

/** Pull the lattice/site/depth/seed metadata out of whichever envelope shape arrived. */
function envelopeMeta(value) {
  const extras = value?.extras ?? {};
  const spec = extras.spec ?? value?.spec ?? {};
  const params = value?.params ?? {};
  const provenance = value?.provenance ?? {};
  const data = value?.data ?? {};
  return {
    lattice: firstString(spec.lattice, extras.lattice, params.lattice),
    sites: firstNumber(spec.n_sites, extras.n_sites, extras.sites, data.sites, params.n_sites),
    depth: firstNumber(spec.depth, extras.depth, data.steps, params.depth),
    seed: firstNumber(provenance.seed, spec.seed, extras.seed, params.seed),
  };
}

function compactTap(tap, includeZ) {
  const compact = {
    site: round(tap.site),
    depth: round(tap.depth),
    level: round(tap.level),
    polarity: tap.polarity ?? 1,
    fRe: round(tap.F_re ?? tap.f_re ?? 0),
    fIm: round(tap.F_im ?? tap.f_im ?? 0),
  };
  if (typeof tap.x === 'number') compact.x = tap.x;
  if (typeof tap.y === 'number') compact.y = tap.y;
  if (includeZ && typeof tap.z === 'number') compact.z = tap.z;
  if (typeof tap.time_ms === 'number') compact.timeMs = tap.time_ms;
  else if (typeof tap.timeMs === 'number') compact.timeMs = tap.timeMs;
  return compact;
}

export function bake(job, ctx) {
  const options = ctx.bake ?? {};
  if (typeof options.slot === 'string' && !ctx.files.has(options.slot) && (ctx.result === undefined || ctx.result === null)) {
    requireFile(ctx, options.slot, type);
  }
  const candidates = candidateSources(ctx, options);
  let found = null;
  for (const candidate of candidates) {
    const taps = tapsFrom(candidate.value);
    if (taps && taps.length) {
      found = { source: candidate, taps };
      break;
    }
  }
  if (!found) {
    const available = [...ctx.files.keys()].join(', ') || 'none';
    throw new Error(`${type}: no tap map found in the result or JSON slots (available: ${available})`);
  }

  const maxTaps = options.maxTaps ?? 64;
  if (!Number.isInteger(maxTaps) || maxTaps <= 0) throw new Error(`${type}.maxTaps must be a positive integer`);
  const meta = envelopeMeta(found.source.value);
  const includeZ = options.includeZ === true;

  const irSlot = options.irSlot
    ?? (ctx.files.has('ir') ? 'ir' : found.source.slot)
    ?? null;
  const irFile = (irSlot && ctx.saved?.get(irSlot)?.relative) || found.source.saved?.relative || null;
  let irUrl = null;
  if (typeof options.url === 'string' || typeof options.urlBase === 'string') {
    irUrl = resolveUrl(options, ctx, irSlot ?? found.source.slot);
  }

  const value = {
    lattice: meta.lattice,
    sites: meta.sites,
    depth: meta.depth,
    seed: meta.seed,
    count: found.taps.length,
    taps: found.taps.slice(0, maxTaps).map((tap) => compactTap(tap, includeZ)),
    irFile,
    irUrl,
  };
  if (options.meta !== undefined && options.meta !== null) value.meta = options.meta;

  return {
    bucket: options.bucket ?? defaultBucket,
    key: options.name ?? job.id,
    value,
  };
}

export default bake;
