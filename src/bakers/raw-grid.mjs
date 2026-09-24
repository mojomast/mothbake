// Keep measured scalar fields as numeric data rather than applying the
// display-only min/max rescaling used by image-oriented bakers.
import { gridOf } from './util.mjs';

export const type = 'raw-grid';
export const defaultBucket = 'grids';

export function bake(job, ctx) {
  const grid = gridOf(ctx.result);
  if (!Array.isArray(grid) || !grid.length || !Array.isArray(grid[0]) || !grid[0].length) {
    throw new Error('raw-grid: no nonempty 2D grid found in the job result');
  }
  const width = grid[0].length;
  if (!grid.every((row) => Array.isArray(row) && row.length === width && row.every((v) => typeof v === 'number' && Number.isFinite(v)))) {
    throw new Error('raw-grid: expected a rectangular grid of finite numbers');
  }
  return {
    bucket: ctx.bake?.bucket ?? defaultBucket,
    key: ctx.bake?.name ?? job.id,
    value: { width, height: grid.length, values: grid.map((row) => [...row]) },
  };
}
