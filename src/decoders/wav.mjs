// Dependency-free RIFF/WAVE inspector. Parses the container and reports the
// format plus duration without decoding samples; baking only needs a
// descriptor for the impulse response, not the PCM itself.

const FORMAT_NAMES = { 1: 'pcm', 3: 'float', 6: 'alaw', 7: 'mulaw', 0xfffe: 'extensible' };

/**
 * @param {Buffer|Uint8Array} buffer
 * @returns {{ format: string, channels: number, sampleRate: number, bits: number, dataBytes: number, frames: number, seconds: number }}
 */
export function wavInfo(buffer) {
  if (buffer.length < 44) throw new Error('wav: file too small');
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('wav: not a RIFF/WAVE file');
  }
  let offset = 12;
  let formatCode = 1;
  let channels = 1;
  let sampleRate = 44100;
  let bits = 16;
  let dataBytes = 0;
  let sawFmt = false;
  let sawData = false;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buffer.length) throw new Error('wav: truncated fmt chunk');
      formatCode = buffer.readUInt16LE(body);
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bits = buffer.readUInt16LE(body + 14);
      if (formatCode === 0xfffe && size >= 40) formatCode = buffer.readUInt16LE(body + 24);
      sawFmt = true;
    } else if (id === 'data') {
      dataBytes = Math.min(size, buffer.length - body);
      sawData = true;
    }
    offset += 8 + size + (size % 2);
  }
  if (!sawFmt) throw new Error('wav: fmt chunk missing');
  if (!sawData) throw new Error('wav: data chunk missing');
  if (!channels || !sampleRate) throw new Error('wav: invalid channel count or sample rate');
  const frameBytes = channels * Math.max(1, bits / 8);
  const frames = Math.floor(dataBytes / frameBytes);
  return {
    format: FORMAT_NAMES[formatCode] || `code-${formatCode}`,
    channels,
    sampleRate,
    bits,
    dataBytes,
    frames,
    seconds: dataBytes / Math.max(1, frameBytes * sampleRate),
  };
}
