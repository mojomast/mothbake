// ir: describe an impulse-response WAV result (duration, format, and an
// optional tap map for cheap synthetic fallbacks).
//
// The descriptor carries `file`, a path relative to the bake output dir, so
// emitters can copy the audio next to the record. `url` is only populated when
// the bake config asks for it (`url` or `urlBase`), which keeps the tool free
// of any hosting assumptions.

import path from 'node:path';
import { wavInfo } from '../decoders/wav.mjs';
import { requireFile } from './util.mjs';

export const type = 'ir';
export const defaultBucket = 'irs';

const TAP_KEYS = ['taps', 'tap_map', 'ir', 'feedback_taps'];

/** Find the first tap list under a known key, to a bounded depth. */
function tapsFrom(value) {
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

export function bake(job, ctx) {
  const options = ctx.bake ?? {};
  const slot = options.slot ?? 'result';
  const info = wavInfo(requireFile(ctx, slot, type));
  let taps = null;
  const preferred = new Set([options.tapsSlot ?? 'taps', 'ir', 'tap_map']);
  const candidates = [
    ...[...ctx.files].filter(([name]) => preferred.has(name)),
    ...[...ctx.files].filter(([name]) => !preferred.has(name)),
  ];
  for (const [, buffer] of candidates) {
    try {
      taps = tapsFrom(JSON.parse(buffer.toString('utf8')));
      if (taps) break;
    } catch {
      // Not JSON: keep looking at the other slots.
    }
  }
  if (taps) taps = taps.slice(0, options.maxTaps ?? 64);
  const saved = ctx.saved?.get(slot);
  const relative = saved?.relative ?? null;
  const rawName = ctx.rawName ?? job.raw ?? job.id;
  let url = null;
  if (typeof options.url === 'string') {
    url = options.url
      .replaceAll('{raw}', rawName)
      .replaceAll('{slot}', slot)
      .replaceAll('{file}', relative ? path.basename(relative) : '');
  } else if (typeof options.urlBase === 'string' && relative) {
    url = `${options.urlBase.replace(/\/+$/, '')}/${rawName}/${path.basename(relative)}`;
  }
  return {
    bucket: options.bucket ?? defaultBucket,
    key: options.name ?? job.id,
    value: {
      file: relative,
      url,
      seconds: Math.round(info.seconds * 1000) / 1000,
      sampleRate: info.sampleRate,
      channels: info.channels,
      format: info.format,
      taps,
    },
  };
}
