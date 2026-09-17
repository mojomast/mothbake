// normal-map: derive a tangent-space normal map from a blurred height grid.

import { gridToNormal, resampleGrid } from '../image.mjs';
import { gridOf, imageValue, positiveInt, positiveNumber } from './util.mjs';

export const type = 'normal-map';
export const defaultBucket = 'normals';

export function bake(job, ctx) {
  const options = ctx.bake ?? {};
  const grid = gridOf(ctx.result);
  if (!grid) throw new Error(`${type}: no 2D grid found in the job result`);
  const size = positiveInt(options.size ?? 32, `${type}.size`);
  const strength = positiveNumber(options.strength ?? 1.6, `${type}.strength`);
  const field = resampleGrid(grid, size, size);
  const normal = gridToNormal(field, size, size, strength);
  return {
    bucket: options.bucket ?? defaultBucket,
    key: options.name ?? job.id,
    value: imageValue(normal, size, size),
  };
}
