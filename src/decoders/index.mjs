// Decoder registry: every format mothbake can read with zero dependencies.
export { decodePng, encodePng, crc32 } from './png.mjs';
export { unzip, zip } from './zip.mjs';
export { decodeHdr } from './hdr.mjs';
export { wavInfo, decodeWav, encodeWav, mixdownChannels } from './wav.mjs';
export { decodeGif } from './gif.mjs';
export { decodeMidi, encodeMidi } from './midi.mjs';

export const decoders = {
  png: ['decodePng', 'encodePng'],
  gif: ['decodeGif'],
  zip: ['unzip', 'zip'],
  hdr: ['decodeHdr'],
  wav: ['wavInfo', 'decodeWav', 'encodeWav'],
  midi: ['decodeMidi', 'encodeMidi'],
};
