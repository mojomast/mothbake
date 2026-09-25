// sky: downscale a wide PNG result into an equirectangular RGBA texture.

import { decodePng } from '../decoders/png.mjs';
import { resizeNearest } from '../image.mjs';
import { imageValue, positiveInt, requireFile } from './util.mjs';

export const type = 'sky';
export const defaultBucket = 'sky';

export function bake(job, ctx) {
  const options = ctx.bake ?? {};
  if (options.sourceProjection !== 'equirectangular') {
    throw new Error(`${type}.sourceProjection must be "equirectangular"; aspect ratio alone does not prove or convert projection`);
  }
  const image = decodePng(requireFile(ctx, options.slot ?? 'result', type));
  const width = positiveInt(options.width ?? 256, `${type}.width`);
  const height = positiveInt(options.height ?? 128, `${type}.height`);
  const small = resizeNearest(image.data, image.width, image.height, width, height, 4);
  return {
    bucket: options.bucket ?? defaultBucket,
    key: options.name ?? job.id,
    value: {
      ...imageValue(small, width, height),
      sourceProjection: 'equirectangular',
      projectionConversion: 'none',
      equirect: true,
    },
  };
}
