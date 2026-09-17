// texture-tile: downscale a PNG result into a small RGBA tile.

import { decodePng } from '../decoders/png.mjs';
import { resizeNearest } from '../image.mjs';
import { imageValue, positiveInt, requireFile } from './util.mjs';

export const type = 'texture-tile';
export const defaultBucket = 'textures';

export function bake(job, ctx) {
  const options = ctx.bake ?? {};
  const image = decodePng(requireFile(ctx, options.slot ?? 'result', type));
  const size = positiveInt(options.size ?? 64, `${type}.size`);
  const small = resizeNearest(image.data, image.width, image.height, size, size, 4);
  return {
    bucket: options.bucket ?? defaultBucket,
    key: options.name ?? job.id,
    value: imageValue(small, size, size),
  };
}
