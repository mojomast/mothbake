// Decoder registry: every format mothbake can read with zero dependencies.
export { decodePng, encodePng, crc32 } from './png.mjs';
export { unzip } from './zip.mjs';
export { decodeHdr } from './hdr.mjs';
export { wavInfo } from './wav.mjs';
export { decodeMidi, encodeMidi } from './midi.mjs';

export const decoders = {
  png: ['decodePng', 'encodePng'],
  zip: ['unzip'],
  hdr: ['decodeHdr'],
  wav: ['wavInfo'],
  midi: ['decodeMidi', 'encodeMidi'],
};
