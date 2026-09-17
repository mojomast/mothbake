// audio-stitch: concatenate an ordered list of WAV slots into one clip record.
//
// Needed to splice several engine outputs or a set of short model takes into a
// single bed. Each entry is a slot name or `{ slot, gain }`; `gains` may supply
// a parallel gain array. Adjacent clips are joined with an equal-power
// `crossfadeMs` (default 0 = a hard cut). The output is an `audio-clip`-shaped
// record, so every emitter and consumer already understands it.
//
// Determinism: linear resampling, equal-power crossfades and the WAV encoder
// are all pure, so the same slots and options produce byte-identical output.
//
// Options: `slots` (alias `order`), `gains`, `crossfadeMs`, `mixdown`,
// `maxChannels`, `targetSampleRate`, `maxSeconds`, `sampleFormat`, `normalize`,
// `peak`, `loopStart`, `loopEnd`, `detectLoop`, `loopSearch`, `loopWindow`,
// `loopThreshold`, `loopCrossfade`, `embed`, `file`, `url`, `urlBase`, `meta`,
// `name`, `bucket`.

import { decodeWav, mixdownChannels } from '../decoders/wav.mjs';
import { requireFile } from './util.mjs';
import {
  applyGain,
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

export const type = 'audio-stitch';
export const defaultBucket = 'audio';

function normalizeOrder(options, type) {
  const raw = options.order ?? options.slots;
  if (!Array.isArray(raw) || !raw.length) throw new Error(`${type}.slots must be a non-empty array of slot names`);
  const gains = options.gains;
  if (gains !== undefined && !Array.isArray(gains)) throw new Error(`${type}.gains must be an array`);
  return raw.map((entry, index) => {
    if (typeof entry === 'string' && entry) {
      const gain = gains?.[index] ?? 1;
      return { slot: entry, gain };
    }
    if (entry && typeof entry === 'object' && typeof entry.slot === 'string' && entry.slot) {
      const gain = entry.gain ?? gains?.[index] ?? 1;
      return { slot: entry.slot, gain };
    }
    throw new Error(`${type}.slots[${index}] must be a slot name or { slot, gain }`);
  }).map((entry) => {
    if (typeof entry.gain !== 'number' || !Number.isFinite(entry.gain)) {
      throw new Error(`${type}.slots gain must be a finite number`);
    }
    return entry;
  });
}

/** Equal-power crossfade of the last `fade` frames of `prev` into `next`. */
function stitchPair(prev, next, fade, slotA, slotB) {
  const frames = prev[0].length;
  const nextFrames = next[0].length;
  if (fade >= frames || fade >= nextFrames) {
    throw new Error(`audio-stitch: crossfade ${fade} frames is too long for "${slotA}" (${frames}) or "${slotB}" (${nextFrames})`);
  }
  const outFrames = frames - fade + nextFrames;
  return prev.map((channel, index) => {
    const other = next[index];
    const out = new Float32Array(outFrames);
    out.set(channel.subarray(0, frames - fade), 0);
    for (let i = 0; i < fade; i++) {
      const angle = ((i + 1) / (fade + 1)) * (Math.PI / 2);
      out[frames - fade + i] = channel[frames - fade + i] * Math.cos(angle) + other[i] * Math.sin(angle);
    }
    out.set(other.subarray(fade), frames);
    return out;
  });
}

export function bake(job, ctx) {
  const options = ctx.bake ?? {};
  const order = normalizeOrder(options, type);
  const spliceFade = optionalNumber(options.crossfadeMs, `${type}.crossfadeMs`) ?? 0;
  if (spliceFade < 0) throw new Error(`${type}.crossfadeMs must be a non-negative number`);

  const targetRate = optionalNumber(options.targetSampleRate, `${type}.targetSampleRate`);
  if (targetRate !== null && !(targetRate > 0)) throw new Error(`${type}.targetSampleRate must be a positive number`);
  const maxChannels = options.maxChannels ?? 8;

  const decodedClips = order.map(({ slot, gain }) => {
    const decoded = decodeWav(requireFile(ctx, slot, type), { maxChannels });
    let channels = options.mixdown ? [mixdownChannels(decoded.channelData)] : decoded.channelData;
    channels = applyGain(channels, gain);
    return { slot, gain, sampleRate: decoded.sampleRate, channels };
  });

  const sampleRate = targetRate ?? decodedClips[0].sampleRate;
  for (const clip of decodedClips) {
    if (clip.sampleRate !== sampleRate) clip.channels = resampleLinear(clip.channels, clip.sampleRate, sampleRate);
    clip.sampleRate = sampleRate;
  }
  const channelCount = decodedClips[0].channels.length;
  if (!options.mixdown) {
    const offender = decodedClips.find((clip) => clip.channels.length !== channelCount);
    if (offender) {
      throw new Error(`${type}: channel count mismatch ("${decodedClips[0].slot}" has ${channelCount}, "${offender.slot}" has ${offender.channels.length}); use mixdown: true`);
    }
  }

  const fadeFrames = Math.round((spliceFade / 1000) * sampleRate);
  let channels = decodedClips[0].channels;
  for (let i = 1; i < decodedClips.length; i++) {
    channels = stitchPair(channels, decodedClips[i].channels, fadeFrames, decodedClips[i - 1].slot, decodedClips[i].slot);
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

  const loopCrossfade = optionalNumber(options.loopCrossfade, `${type}.loopCrossfade`);
  if (loopCrossfade !== null && loopCrossfade > 0) {
    if (loopEnd === null) throw new Error(`${type}.loopCrossfade needs a loop window (set loopStart/loopEnd or detectLoop: true)`);
    channels = crossfadeAtSeam(
      channels,
      Math.round((loopStart ?? 0) * sampleRate),
      Math.round(loopEnd * sampleRate),
      Math.round(loopCrossfade * sampleRate),
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
    crossfade: null,
    options,
    ctx,
    slot: null,
    type,
  });
  value.source = {
    crossfadeMs: spliceFade,
    sampleRate,
    channels: channelCount,
    frames,
    seconds: round(seconds),
    clips: decodedClips.map((clip) => ({
      slot: clip.slot,
      gain: round(clip.gain),
      sampleRate: clip.sampleRate,
      frames: clip.channels[0].length,
    })),
  };

  return {
    bucket: options.bucket ?? defaultBucket,
    key: options.name ?? job.id,
    value,
  };
}

export default bake;
