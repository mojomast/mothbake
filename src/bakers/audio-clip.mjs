// audio-clip: turn a WAV result into a trimmed, peak-normalised clip record.
//
// The baker decodes PCM/float WAVs with the dependency-free decoder, optionally
// trims leading/trailing silence, resamples, normalises the peak, finds a loop
// seam, re-encodes a WAV and emits a portable record. By default the WAV is
// embedded as base64 (`{}` is small); for beds and other large clips set
// `embed: false` to emit a `file` reference instead, exactly like `ir`.
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
//   - `loopStart`/`loopEnd` are seconds measured from the start of the final
//     clip; an omitted endpoint defaults to 0 / the clip length.
//   - `detectLoop: false` finds a loop seam by head/tail correlation
//     (`loopSearch`, `loopWindow`, `loopThreshold`); explicit loop points win.
//   - `loopCrossfade` (seconds) equal-power blends the tail into the head at
//     the seam so the loop is continuous.
//   - `targetSampleRate`/`maxSeconds` decimate/trim so beds stay small.
//   - `embed: false` plus `url`/`urlBase` emits a file reference, not base64.
//   - `meta` is copied into the record verbatim (routing hints, tags, …).

import { decodeWav, mixdownChannels } from '../decoders/wav.mjs';
import { requireFile } from './util.mjs';
import {
  autoTrim,
  clamp,
  crossfadeAtSeam,
  detectLoop,
  encodeAndDescribe,
  limitFrames,
  optionalNumber,
  peakOf,
  resampleLinear,
  round,
  scaleChannels,
} from './audio.mjs';

export const type = 'audio-clip';
export const defaultBucket = 'audio';

export function bake(job, ctx) {
  const options = ctx.bake ?? {};
  const slot = options.slot ?? 'result';
  const decoded = decodeWav(requireFile(ctx, slot, type), { maxChannels: options.maxChannels ?? 8 });
  const sourceSampleRate = decoded.sampleRate;
  const inputFrames = decoded.frames;
  let sampleRate = sourceSampleRate;
  let channels = options.mixdown ? [mixdownChannels(decoded.channelData)] : decoded.channelData;

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
  channels = channels.map((channel) => channel.subarray(start, end));

  const targetSampleRate = optionalNumber(options.targetSampleRate, `${type}.targetSampleRate`);
  if (targetSampleRate !== null) {
    if (!(targetSampleRate > 0)) throw new Error(`${type}.targetSampleRate must be a positive number`);
    channels = resampleLinear(channels, sampleRate, targetSampleRate);
    sampleRate = targetSampleRate;
  }
  const maxSeconds = optionalNumber(options.maxSeconds, `${type}.maxSeconds`);
  if (maxSeconds !== null) {
    if (!(maxSeconds > 0)) throw new Error(`${type}.maxSeconds must be a positive number`);
    channels = limitFrames(channels, Math.max(1, Math.round(maxSeconds * sampleRate)));
  }

  const frames = channels[0].length;
  const seconds = frames / sampleRate;

  let loopStart = optionalNumber(options.loopStart, `${type}.loopStart`);
  let loopEnd = optionalNumber(options.loopEnd, `${type}.loopEnd`);
  let loopScore = null;
  if (loopStart === null && loopEnd === null && options.detectLoop) {
    const detected = detectLoop(channels, sampleRate, {
      searchSeconds: optionalNumber(options.loopSearch, `${type}.loopSearch`) ?? undefined,
      windowSeconds: optionalNumber(options.loopWindow, `${type}.loopWindow`) ?? undefined,
      threshold: optionalNumber(options.loopThreshold, `${type}.loopThreshold`) ?? undefined,
    });
    loopStart = detected.loopStart;
    loopEnd = detected.loopEnd;
    loopScore = detected.score;
  }
  if (loopStart !== null && (loopStart < 0 || loopStart > seconds)) {
    throw new Error(`${type}.loopStart ${loopStart} is outside the clip (0..${round(seconds)})`);
  }
  if (loopEnd !== null && (loopEnd < 0 || loopEnd > seconds)) {
    throw new Error(`${type}.loopEnd ${loopEnd} is outside the clip (0..${round(seconds)})`);
  }
  if (loopStart !== null && loopEnd !== null && loopStart >= loopEnd) {
    throw new Error(`${type}.loopStart ${loopStart} must be less than loopEnd ${loopEnd}`);
  }

  const crossfade = optionalNumber(options.loopCrossfade, `${type}.loopCrossfade`);
  if (crossfade !== null && crossfade > 0) {
    if (loopEnd === null) throw new Error(`${type}.loopCrossfade needs a loop window (set loopStart/loopEnd or detectLoop: true)`);
    channels = crossfadeAtSeam(
      channels,
      Math.round((loopStart ?? 0) * sampleRate),
      Math.round(loopEnd * sampleRate),
      Math.round(crossfade * sampleRate),
    );
  }

  const peak = peakOf(channels);
  const target = optionalNumber(options.peak, `${type}.peak`) ?? 1;
  const gain = options.normalize === false || peak === 0 ? 1 : target / peak;
  channels = scaleChannels(channels, gain);

  const value = encodeAndDescribe({
    channels,
    sampleRate,
    sampleFormat: options.sampleFormat ?? 'pcm16',
    gain,
    peak,
    loopStart,
    loopEnd,
    loopScore,
    crossfade,
    options,
    ctx,
    slot,
    type,
  });
  value.trimStart = round(start / sourceSampleRate);
  value.trimEnd = round(end / sourceSampleRate);
  if (targetSampleRate !== null) value.targetSampleRate = targetSampleRate;
  value.source = {
    sampleRate: sourceSampleRate,
    channels: decoded.channels,
    bits: decoded.bits,
    format: decoded.format,
    frames: inputFrames,
    seconds: round(inputFrames / sourceSampleRate),
  };

  return {
    bucket: options.bucket ?? defaultBucket,
    key: options.name ?? job.id,
    value,
  };
}

export default bake;
