// material-lut: pull reflectance/transmittance HDR LUTs out of a ZIP result
// and tone-map each into a small 8-bit RGB LUT.

import { decodeHdr } from '../decoders/hdr.mjs';
import { unzip } from '../decoders/zip.mjs';
import { hdrToRgb8, toBase64 } from '../image.mjs';
import { hashBytes } from '../identity.mjs';
import { positiveInt, requireFile } from './util.mjs';

export const type = 'material-lut';
export const defaultBucket = 'materials';

export function bake(job, ctx) {
  const options = ctx.bake ?? {};
  const archive = requireFile(ctx, options.slot ?? 'result', type);
  const entries = unzip(archive);
  const find = (suffix) => {
    const wanted = suffix.toLowerCase();
    for (const [name, data] of entries) {
      if (name.toLowerCase().endsWith(wanted)) return data;
    }
    return null;
  };
  const reflectanceSuffix = options.reflectance ?? 'r_lut.hdr';
  const transmittanceSuffix = options.transmittance ?? 't_lut.hdr';
  const reflectance = find(reflectanceSuffix);
  const transmittance = find(transmittanceSuffix);
  if (!reflectance || !transmittance) {
    throw new Error(
      `${type}: "${reflectanceSuffix}" / "${transmittanceSuffix}" not found in archive (entries: ${[...entries.keys()].join(', ') || 'none'})`,
    );
  }
  const size = positiveInt(options.size ?? 24, `${type}.size`);
  const r = hdrToRgb8(decodeHdr(reflectance), size);
  const t = hdrToRgb8(decodeHdr(transmittance), size);
  return {
    bucket: options.bucket ?? defaultBucket,
    key: options.name ?? job.id,
    value: {
      size,
      format: 'rgb8',
      r: toBase64(r),
      t: toBase64(t),
      preview: { size, format: 'rgb8', toneMapped: true },
      masters: {
        reflectance: { container: 'radiance-hdr', data: toBase64(reflectance), bytes: reflectance.length, sha256: hashBytes(reflectance) },
        transmittance: { container: 'radiance-hdr', data: toBase64(transmittance), bytes: transmittance.length, sha256: hashBytes(transmittance) },
      },
      axes: options.axes ?? null,
      units: options.units ?? null,
      coordinateConvention: options.coordinateConvention ?? null,
      interpretation: 'Reflectance/transmittance LUT masters; not PBR roughness or metallic maps.',
    },
  };
}
