// effect-frame: bake one frame of an animated effect from a scalar grid.
// Frames sharing a bucket+key merge into `{ fps, frames: [...] }`.

import { gridToRamp, RAMPS, resampleGrid } from '../image.mjs';
import { gridOf, imageValue, positiveInt } from './util.mjs';

export const type = 'effect-frame';
export const defaultBucket = 'effects';

export function bake(job, ctx) {
  const options = ctx.bake ?? {};
  const grid = gridOf(ctx.result);
  if (!grid) throw new Error(`${type}: no 2D grid found in the job result`);
  const size = positiveInt(options.size ?? 48, `${type}.size`);
  const index = options.index ?? 0;
  if (!Number.isInteger(index) || index < 0) throw new Error(`${type}.index must be a non-negative integer`);
  const fps = options.fps ?? 10;
  if (typeof fps !== 'number' || !(fps > 0)) throw new Error(`${type}.fps must be a positive number`);
  const ramps = options.ramps ? { ...RAMPS, ...options.ramps } : RAMPS;
  const field = resampleGrid(grid, size, size);
  const rgba = gridToRamp(field, size, size, options.ramp ?? options.tint ?? 'quantum', ramps);
  return {
    bucket: options.bucket ?? defaultBucket,
    // `effect` is accepted as a key alias for configs that named the effect
    // separately from the record name.
    key: options.name ?? options.effect ?? job.id,
    merge: 'frames',
    index,
    fps,
    value: imageValue(rgba, size, size),
  };
}
