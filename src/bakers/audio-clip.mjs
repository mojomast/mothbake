// audio-clip: turn a WAV result into a trimmed, peak-normalised clip record.
//
// The baker decodes PCM/float WAVs with the dependency-free decoder, optionally
// trims leading/trailing silence, normalises the peak, and re-encodes a small
// self-contained WAV (base64) so emitters and consumers need no extra files.
//
// Defaults:
//   - `trim: true` removes leading/trailing silence below `threshold`
//     (default 0.001 amplitude) and then restores `pad` seconds (default 0)
//     on each side. `trimStart`/`trimEnd` (seconds) override auto-detection on
//     that side; `trim: false` disables auto-trim entirely.
//   - `normalize: true` scales so the loudest sample reaches `peak`
//     (default 1). `gain` and the pre-normalisation `peak` are recorded.
//   - `sampleFormat: 'pcm16'` (also `pcm8`, `pcm24`, `pcm32`, `float32`).
//   - `mixdown: false` keeps the source channel count; `mixdown: true` averages
//     to mono. More than `maxChannels` (default 8) channels are rejected by the
//     decoder with a clear error.
//   - `loopStart`/`loopEnd` are seconds measured from the start of the trimmed
//     clip; an omitted endpoint defaults to 0 / the clip length.

import { decodeWav, encodeWav, mixdownChannels } from '../decoders/wav.mjs';
import { toBase64 } from '../image.mjs';
import { requireFile } from './util.mjs';

export const type = 'audio-clip';
export const defaultBucket = 'audio';

const SAMPLE_FORMATS = new Set(['pcm8', 'pcm16', 'pcm24', 'pcm32', 'float32']);

const round = (value) => Math.round(value * 1e6) / 1e6;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function autoTrim(channelData, threshold) {
  const frames = channelData[0].length;
  let first = -1;
  let last = -1;
  for (let i = 0; i < frames; i++) {
    let level = 0;
    for (const channel of channelData) {
      const value = Math.abs(channel[i]);
      if (value > level) level = value;
    }
    if (level >= threshold) {
      if (first < 0) first = i;
      last = i;
    }
  }
  return first < 0 ? null : { first, last };
}

function optionalNumber(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

export function bake(job, ctx) {
  const options = ctx.bake ?? {};
  const slot = options.slot ?? 'result';
  const decoded = decodeWav(requireFile(ctx, slot, type), { maxChannels: options.maxChannels ?? 8 });
  const sampleRate = decoded.sampleRate;
  const inputFrames = decoded.frames;
  const channels = options.mixdown ? [mixdownChannels(decoded.channelData)] : decoded.channelData;

  const threshold = options.threshold ?? 0.001;
  if (typeof threshold !== 'number' || !(threshold >= 0)) throw new Error(`${type}.threshold must be a non-negative number`);
  const pad = options.pad ?? 0;
  if (typeof pad !== 'number' || !(pad >= 0)) throw new Error(`${type}.pad must be a non-negative number`);

  const explicitStart = optionalNumber(options.trimStart, `${type}.trimStart`);
  const explicitEnd = optionalNumber(options.trimEnd, `${type}.trimEnd`);
  const auto = options.trim === false ? null : autoTrim(decoded.channelData, threshold);

  let start = explicitStart !== null ? Math.round(explicitStart * sampleRate) : auto ? auto.first : 0;
  let end = explicitEnd !== null ? Math.round(explicitEnd * sampleRate) : auto ? auto.last + 1 : inputFrames;
  if (auto && options.trim !== false) {
    const padding = Math.round(pad * sampleRate);
    if (explicitStart === null) start -= padding;
    if (explicitEnd === null) end += padding;
  }
  start = clamp(start, 0, inputFrames);
  end = clamp(end, 0, inputFrames);
  if (end <= start) {
    throw new Error(`${type}: trim range is empty (${start}..${end} of ${inputFrames} frames); check trimStart/trimEnd/threshold`);
  }

  const trimmed = channels.map((channel) => channel.subarray(start, end));
  const frames = end - start;
  let peak = 0;
  for (const channel of trimmed) {
    for (let i = 0; i < channel.length; i++) {
      const value = Math.abs(channel[i]);
      if (value > peak) peak = value;
    }
  }
  const target = optionalNumber(options.peak, `${type}.peak`) ?? 1;
  const gain = options.normalize === false || peak === 0 ? 1 : target / peak;
  const output = gain === 1 ? trimmed : trimmed.map((channel) => {
    const scaled = new Float32Array(channel.length);
    for (let i = 0; i < channel.length; i++) scaled[i] = clamp(channel[i] * gain, -1, 1);
    return scaled;
  });

  const sampleFormat = options.sampleFormat ?? 'pcm16';
  if (!SAMPLE_FORMATS.has(sampleFormat)) {
    throw new Error(`${type}.sampleFormat "${sampleFormat}" unsupported (expected ${[...SAMPLE_FORMATS].join(', ')})`);
  }
  const wav = encodeWav(output, { sampleRate, format: sampleFormat });
  const seconds = frames / sampleRate;

  const loopStart = optionalNumber(options.loopStart, `${type}.loopStart`);
  const loopEnd = optionalNumber(options.loopEnd, `${type}.loopEnd`);
  if (loopStart !== null && (loopStart < 0 || loopStart > seconds)) {
    throw new Error(`${type}.loopStart ${loopStart} is outside the clip (0..${round(seconds)})`);
  }
  if (loopEnd !== null && (loopEnd < 0 || loopEnd > seconds)) {
    throw new Error(`${type}.loopEnd ${loopEnd} is outside the clip (0..${round(seconds)})`);
  }
  if (loopStart !== null && loopEnd !== null && loopStart >= loopEnd) {
    throw new Error(`${type}.loopStart ${loopStart} must be less than loopEnd ${loopEnd}`);
  }

  return {
    bucket: options.bucket ?? defaultBucket,
    key: options.name ?? job.id,
    value: {
      container: 'wav',
      format: sampleFormat.startsWith('float') ? 'float' : 'pcm',
      sampleFormat,
      sampleRate,
      channels: output.length,
      frames,
      seconds: round(seconds),
      data: toBase64(wav),
      loopStart,
      loopEnd,
      gain: round(gain),
      peak: round(peak),
      trimStart: round(start / sampleRate),
      trimEnd: round(end / sampleRate),
      source: {
        sampleRate,
        channels: decoded.channels,
        bits: decoded.bits,
        format: decoded.format,
        frames: inputFrames,
        seconds: round(inputFrames / sampleRate),
      },
    },
  };
}

export default bake;
