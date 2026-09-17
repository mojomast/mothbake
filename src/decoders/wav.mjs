// Dependency-free RIFF/WAVE codec.
//
// `wavInfo()` is the metadata helper the `ir` baker uses: it parses the
// container and reports format, duration and frame count without touching the
// samples. `decodeWav()` goes further and decodes real PCM into normalized
// float channels, and `encodeWav()` writes a canonical little-endian WAV so
// decoded clips can be re-emitted.
//
// Supported by `decodeWav`:
//   - PCM   (format 1): 8-bit unsigned, 16/24/32-bit signed
//   - float (format 3): 32-bit IEEE float
//   - any channel count up to `maxChannels` (default 8); >2 channels decode
//     as-is or mix down to mono with `{ mixdown: true }`
//
// Deliberately rejected with a clear error: A-law, µ-law, ADPCM and other
// compressed WAVE formats, non-8/16/24/32-bit PCM, 64-bit float, and more
// channels than `maxChannels`.
//
// `decodeWav` returns normalized samples in [-1, 1]:
//
//   { format, sampleRate, bits, channels, frames, seconds, dataBytes,
//     channelData: Float32Array[], samples?: Float32Array }
//
// `channelData[i]` is one channel; `samples` is the mono mixdown and is only
// present when `mixdown: true`.

const FORMAT_NAMES = { 1: 'pcm', 3: 'float', 6: 'alaw', 7: 'mulaw', 0xfffe: 'extensible' };
const PCM_BITS = new Set([8, 16, 24, 32]);
const MAX_CHANNELS = 8;

function asBuffer(buffer) {
  return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer.buffer ?? buffer, buffer.byteOffset ?? 0, buffer.byteLength ?? buffer.length);
}

/** Parse the RIFF container into a header description plus the data window. */
function parseWav(buffer) {
  const buf = asBuffer(buffer);
  if (buf.length < 44) throw new Error('wav: file too small');
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('wav: not a RIFF/WAVE file');
  }
  let offset = 12;
  let formatCode = 1;
  let channels = 1;
  let sampleRate = 44100;
  let bits = 16;
  let blockAlign = 0;
  let dataOffset = -1;
  let dataBytes = 0;
  let sawFmt = false;
  let sawData = false;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buf.length) throw new Error('wav: truncated fmt chunk');
      formatCode = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      blockAlign = buf.readUInt16LE(body + 12);
      bits = buf.readUInt16LE(body + 14);
      if (formatCode === 0xfffe && size >= 40) formatCode = buf.readUInt16LE(body + 24);
      sawFmt = true;
    } else if (id === 'data') {
      dataBytes = Math.min(size, buf.length - body);
      dataOffset = body;
      sawData = true;
    }
    offset += 8 + size + (size % 2);
  }
  if (!sawFmt) throw new Error('wav: fmt chunk missing');
  if (!sawData) throw new Error('wav: data chunk missing');
  if (!channels || !sampleRate) throw new Error('wav: invalid channel count or sample rate');
  const bytesPerSample = Math.max(1, Math.ceil(bits / 8));
  const frameBytes = blockAlign || channels * bytesPerSample;
  const frames = Math.floor(dataBytes / frameBytes);
  return {
    format: FORMAT_NAMES[formatCode] || `code-${formatCode}`,
    formatCode,
    channels,
    sampleRate,
    bits,
    bytesPerSample,
    blockAlign: frameBytes,
    dataOffset,
    dataBytes,
    frames,
    seconds: dataBytes / Math.max(1, frameBytes * sampleRate),
  };
}

/**
 * Inspect a RIFF/WAVE buffer: format, channels, sample rate, bit depth,
 * frame count and duration.
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {{ format: string, channels: number, sampleRate: number, bits: number, dataBytes: number, frames: number, seconds: number }}
 */
export function wavInfo(buffer) {
  const info = parseWav(buffer);
  return {
    format: info.format,
    channels: info.channels,
    sampleRate: info.sampleRate,
    bits: info.bits,
    dataBytes: info.dataBytes,
    frames: info.frames,
    seconds: info.seconds,
  };
}

/**
 * Decode PCM/float WAV samples into normalized float channels.
 *
 * @param {Buffer|Uint8Array} buffer
 * @param {{ mixdown?: boolean, maxChannels?: number }} [options]
 * @returns {{
 *   format: 'pcm'|'float', sampleRate: number, bits: number, channels: number,
 *   frames: number, seconds: number, dataBytes: number,
 *   channelData: Float32Array[], samples?: Float32Array,
 * }}
 */
export function decodeWav(buffer, options = {}) {
  const { mixdown = false, maxChannels = MAX_CHANNELS } = options;
  const info = parseWav(buffer);
  const buf = asBuffer(buffer);
  const { formatCode, bits, channels } = info;
  if (formatCode !== 1 && formatCode !== 3) {
    throw new Error(
      `wav: format "${info.format}" is not supported (only PCM and 32-bit float; A-law/µ-law/ADPCM are rejected)`,
    );
  }
  if (formatCode === 1 && !PCM_BITS.has(bits)) {
    throw new Error(`wav: ${bits}-bit PCM unsupported (expected 8, 16, 24 or 32)`);
  }
  if (formatCode === 3 && bits !== 32) {
    throw new Error(`wav: ${bits}-bit float unsupported (only 32-bit float)`);
  }
  if (channels > maxChannels) {
    throw new Error(`wav: ${channels} channels exceed maxChannels=${maxChannels} (decode a mixdown upstream or raise the limit)`);
  }
  const bytesPerSample = info.bytesPerSample;
  const channelData = Array.from({ length: channels }, () => new Float32Array(info.frames));
  const read = sampleReader(formatCode, bits);
  for (let frame = 0; frame < info.frames; frame++) {
    const base = info.dataOffset + frame * info.blockAlign;
    for (let channel = 0; channel < channels; channel++) {
      channelData[channel][frame] = read(buf, base + channel * bytesPerSample);
    }
  }
  const result = {
    format: formatCode === 1 ? 'pcm' : 'float',
    sampleRate: info.sampleRate,
    bits,
    channels,
    frames: info.frames,
    seconds: info.seconds,
    dataBytes: info.dataBytes,
    channelData,
  };
  if (mixdown) result.samples = mixdownChannels(channelData);
  return result;
}

function sampleReader(formatCode, bits) {
  if (formatCode === 3) {
    return (buffer, offset) => buffer.readFloatLE(offset);
  }
  if (bits === 8) return (buffer, offset) => (buffer.readUInt8(offset) - 128) / 128;
  if (bits === 16) return (buffer, offset) => buffer.readInt16LE(offset) / 32768;
  if (bits === 24) {
    return (buffer, offset) => {
      const value = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
      const signed = value & 0x800000 ? value - 0x1000000 : value;
      return signed / 8388608;
    };
  }
  return (buffer, offset) => buffer.readInt32LE(offset) / 2147483648;
}

/** Average channels to mono. */
export function mixdownChannels(channelData) {
  if (channelData.length === 1) return channelData[0];
  const frames = channelData[0].length;
  const out = new Float32Array(frames);
  for (const channel of channelData) {
    for (let i = 0; i < frames; i++) out[i] += channel[i];
  }
  for (let i = 0; i < frames; i++) out[i] /= channelData.length;
  return out;
}

const ENCODE_BITS = { pcm8: 8, pcm16: 16, pcm24: 24, pcm32: 32, float32: 32 };

/**
 * Encode normalized float channels as a canonical little-endian WAV.
 *
 * @param {Float32Array|Float32Array[]} samples Mono samples or an array of channels.
 * @param {{ sampleRate?: number, format?: 'pcm8'|'pcm16'|'pcm24'|'pcm32'|'float32' }} [options]
 * @returns {Buffer}
 */
export function encodeWav(samples, options = {}) {
  const { sampleRate = 44100, format = 'pcm16' } = options;
  const bits = ENCODE_BITS[format];
  if (!bits) throw new Error(`wav: unknown encode format "${format}" (expected pcm8, pcm16, pcm24, pcm32 or float32)`);
  let channelData;
  if (Array.isArray(samples)) channelData = samples;
  else if (ArrayBuffer.isView(samples)) channelData = [samples];
  else channelData = null;
  if (!channelData || !channelData.length) throw new Error('wav: encode needs at least one channel of samples');
  const channels = channelData.length;
  const frames = channelData[0].length;
  for (const channel of channelData) {
    if (channel.length !== frames) throw new Error('wav: encode channels must all have the same length');
  }
  const bytesPerSample = bits / 8;
  const dataBytes = frames * channels * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(format === 'float32' ? 3 : 1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(bits, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  let offset = 44;
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const value = channelData[channel][frame];
      if (format === 'float32') {
        buffer.writeFloatLE(value, offset);
      } else {
        const clamped = Math.max(-1, Math.min(1, value));
        if (bits === 8) buffer.writeUInt8(Math.round(clamped * 127) + 128, offset);
        else if (bits === 16) buffer.writeInt16LE(Math.round(clamped * 32767), offset);
        else if (bits === 24) {
          const scaled = Math.max(-8388608, Math.min(8388607, Math.round(clamped * 8388607)));
          buffer.writeUInt8(scaled & 0xff, offset);
          buffer.writeUInt8((scaled >> 8) & 0xff, offset + 1);
          buffer.writeUInt8((scaled >> 16) & 0xff, offset + 2);
        } else buffer.writeInt32LE(Math.round(clamped * 2147483647), offset);
      }
      offset += bytesPerSample;
    }
  }
  return buffer;
}

export default wavInfo;
