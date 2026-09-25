// texture-tile: downscale a PNG result into a small RGBA tile.

import { decodePng } from '../decoders/png.mjs';
import { boundaryContinuity, resizeBilinear, resizeNearest } from '../image.mjs';
import { imageValue, positiveInt, requireFile } from './util.mjs';

export const type = 'texture-tile';
export const defaultBucket = 'textures';

export function bake(job, ctx) {
  const options = ctx.bake ?? {};
  const image = decodePng(requireFile(ctx, options.slot ?? 'result', type));
  const size = positiveInt(options.size ?? 64, `${type}.size`);
  const resample = options.resample ?? 'bilinear';
  if (!['bilinear', 'nearest'].includes(resample)) throw new Error(`${type}.resample must be "bilinear" or "nearest"`);
  const small = resample === 'nearest'
    ? resizeNearest(image.data, image.width, image.height, size, size, 4)
    : resizeBilinear(image.data, image.width, image.height, size, size, 4);
  const seam = boundaryContinuity(small, size, size, 4);
  return {
    bucket: options.bucket ?? defaultBucket,
    key: options.name ?? job.id,
    value: {
      ...imageValue(small, size, size),
      resample,
      periodicProcessing: false,
      seamDiagnostics: seam,
      qualityWarnings: seam.exact ? [] : ['Opposite boundaries differ; inspect the 3x3 tiled preview before approval.'],
    },
  };
}
