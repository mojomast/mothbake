// Shared WAV helpers for the audio bakers (`audio-clip`, `audio-stitch`).
//
// Everything here is pure and deterministic: decoding is delegated to the
// dependency-free WAV decoder, resampling is linear (documented approximation),
// loop detection is a normalized cross-correlation over a bounded search
// window, and the seam crossfade is equal-power. No audio framework, no
// randomness, no consumer-specific shape.

import { encodeWav } from '../decoders/wav.mjs';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { toBase64 } from '../image.mjs';
import { writeFileAtomic } from '../publish.mjs';
import { resolveUrl } from './util.mjs';

export { resolveUrl };

export const SAMPLE_FORMATS = new Set(['pcm8', 'pcm16', 'pcm24', 'pcm32', 'float32']);

export const round = (value) => Math.round(value * 1e6) / 1e6;
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** A finite number or null; throws a labelled error otherwise. */
export function optionalNumber(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

/** Auto-trim bounds (first/last frame above `threshold`) or null for silence. */
export function autoTrim(channelData, threshold) {
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

/** Largest absolute sample across every channel. */
export function peakOf(channelData) {
  let peak = 0;
  for (const channel of channelData) {
    for (let i = 0; i < channel.length; i++) {
      const value = Math.abs(channel[i]);
      if (value > peak) peak = value;
    }
  }
  return peak;
}

/** Scale every channel by `gain`, clamping to [-1, 1]. */
export function scaleChannels(channelData, gain) {
  if (gain === 1) return channelData;
  return channelData.map((channel) => {
    const scaled = new Float32Array(channel.length);
    for (let i = 0; i < channel.length; i++) scaled[i] = clamp(channel[i] * gain, -1, 1);
    return scaled;
  });
}

/** Multiply every channel by a per-clip gain (no clamp; encode clamps). */
export function applyGain(channelData, gain) {
  if (gain === 1) return channelData;
  return channelData.map((channel) => {
    const scaled = new Float32Array(channel.length);
    for (let i = 0; i < channel.length; i++) scaled[i] = channel[i] * gain;
    return scaled;
  });
}

/** Trim every channel to the first `maxFrames` frames. */
export function limitFrames(channelData, maxFrames) {
  if (channelData[0].length <= maxFrames) return channelData;
  return channelData.map((channel) => channel.subarray(0, maxFrames));
}

/**
 * Linear resample to a target rate. This is a cheap approximation (no
 * anti-alias filter) that is deterministic and good enough for ambience; it is
 * documented as such rather than pretending to be a high-quality resampler.
 */
export function resampleLinear(channelData, fromRate, toRate) {
  if (fromRate === toRate) return channelData;
  const frames = channelData[0].length;
  const outFrames = Math.max(1, Math.round((frames * toRate) / fromRate));
  if (outFrames === frames) return channelData;
  const last = frames - 1;
  const step = fromRate / toRate;
  return channelData.map((channel) => {
    const out = new Float32Array(outFrames);
    for (let i = 0; i < outFrames; i++) {
      const source = Math.min(i * step, last);
      const i0 = Math.floor(source);
      const i1 = Math.min(i0 + 1, last);
      const t = source - i0;
      out[i] = channel[i0] * (1 - t) + channel[i1] * t;
    }
    return out;
  });
}

/**
 * Windowed-sinc production resampler. Downsampling applies an explicit low-pass
 * cutoff at the target Nyquist frequency; upsampling reconstructs at the source
 * Nyquist frequency. A finite Hann-windowed kernel keeps the dependency-free
 * path deterministic while avoiding the unfiltered aliasing of resampleLinear.
 */
export function resampleFiltered(channelData, fromRate, toRate, options = {}) {
  if (fromRate === toRate) return channelData;
  const radius = options.radius ?? 24;
  if (!Number.isInteger(radius) || radius < 8 || radius > 64) throw new TypeError('audio production resampler radius must be an integer from 8 to 64');
  const frames = channelData[0].length;
  const outFrames = Math.max(1, Math.round((frames * toRate) / fromRate));
  const step = fromRate / toRate;
  const cutoff = Math.min(1, toRate / fromRate);
  const sinc = (x) => Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
  return channelData.map((channel) => {
    const out = new Float32Array(outFrames);
    for (let index = 0; index < outFrames; index++) {
      const center = index * step;
      const first = Math.max(0, Math.floor(center) - radius + 1);
      const last = Math.min(frames - 1, Math.floor(center) + radius);
      let sum = 0;
      let weightSum = 0;
      for (let source = first; source <= last; source++) {
        const distance = source - center;
        const normalized = Math.abs(distance) / radius;
        if (normalized >= 1) continue;
        const window = 0.5 + 0.5 * Math.cos(Math.PI * normalized);
        const weight = cutoff * sinc(cutoff * distance) * window;
        sum += channel[source] * weight;
        weightSum += weight;
      }
      out[index] = weightSum ? clamp(sum / weightSum, -1, 1) : 0;
    }
    return out;
  });
}

/** Select an explicit preview or production resampling path. */
export function resampleChannels(channelData, fromRate, toRate, quality = 'preview') {
  if (quality === 'preview') return resampleLinear(channelData, fromRate, toRate);
  if (quality === 'production') return resampleFiltered(channelData, fromRate, toRate);
  throw new Error(`audio.resampleQuality "${quality}" unsupported (expected preview or production)`);
}

/**
 * Deterministic loop-seam finder. Compares a short head window with candidate
 * windows ending near the tail, scoring seam continuity with an
 * amplitude-aware normalized difference (`1 - Σ(a-b)² / (Σa² + Σb²)`), not a
 * plain correlation (which would call any two DC-ish signals a match). The
 * search walks backwards from the end and accepts the first candidate at or
 * above `threshold`, so the longest seamless loop wins; if none qualifies, the
 * best-scoring candidate is returned. Ties fall back to the longest loop.
 *
 * Options: `searchSeconds` (how far back from the end to search, default 1 s),
 * `windowSeconds` (comparison window, default 0.02 s), `threshold` (minimum
 * score, default 0.5). The candidate window never overlaps the head, so a clip
 * that is not loopable falls back to the whole clip.
 */
export function detectLoop(channelData, sampleRate, options = {}) {
  const frames = channelData[0].length;
  const windowFrames = Math.max(1, Math.min(Math.round((options.windowSeconds ?? 0.02) * sampleRate), Math.max(1, Math.floor(frames / 2))));
  const searchFrames = Math.max(windowFrames, Math.min(frames, Math.round((options.searchSeconds ?? 1) * sampleRate)));
  const startAt = Math.max(2 * windowFrames, frames - searchFrames);
  const threshold = options.threshold ?? 0.5;
  let best = { end: frames, score: -Infinity };
  for (let end = frames; end >= startAt; end--) {
    let score = 0;
    for (const channel of channelData) {
      let diff = 0;
      let energy = 0;
      for (let i = 0; i < windowFrames; i++) {
        const a = channel[i];
        const b = channel[end - windowFrames + i];
        const delta = a - b;
        diff += delta * delta;
        energy += a * a + b * b;
      }
      score += energy > 0 ? 1 - diff / energy : 1;
    }
    score /= channelData.length;
    if (score > best.score) best = { end, score };
    if (score >= threshold) {
      best = { end, score };
      break;
    }
  }
  return { loopStart: 0, loopEnd: round(best.end / sampleRate), score: round(Math.max(0, best.score)) };
}

/**
 * Equal-power crossfade of the tail `[loopEnd, loopEnd+fadeFrames)` onto the
 * head `[loopStart, loopStart+fadeFrames)`, so wrapping from `loopEnd` back to
 * `loopStart` is continuous. Returns new channel arrays; the loop window itself
 * is unchanged. Requires a loop window and enough tail material.
 */
export function crossfadeAtSeam(channelData, loopStartFrame, loopEndFrame, fadeFrames) {
  if (fadeFrames <= 0) return channelData;
  const frames = channelData[0].length;
  if (loopEndFrame + fadeFrames > frames) {
    throw new Error(`audio: loopCrossfade needs ${fadeFrames} frames after loopEnd but only ${frames - loopEndFrame} remain`);
  }
  if (loopStartFrame + fadeFrames > loopEndFrame) {
    throw new Error('audio: loopCrossfade is longer than the loop window');
  }
  return channelData.map((channel) => {
    const out = Float32Array.from(channel);
    for (let i = 0; i < fadeFrames; i++) {
      const angle = ((i + 1) / (fadeFrames + 1)) * (Math.PI / 2);
      const head = out[loopStartFrame + i];
      const tail = out[loopEndFrame + i];
      out[loopStartFrame + i] = clamp(head * Math.sin(angle) + tail * Math.cos(angle), -1, 1);
    }
    return out;
  });
}

/**
 * Encode the channels and build the portable audio value shared by
 * `audio-clip` and `audio-stitch`. Both modes use the same encoded WAV bytes;
 * external mode publishes a derived artifact, never the archived raw input.
 */
export function encodeAndDescribe({ channels, sampleRate, sampleFormat, gain, peak, loopStart, loopEnd, loopScore, crossfade, options, ctx, slot, type }) {
  if (!SAMPLE_FORMATS.has(sampleFormat)) {
    throw new Error(`${type}.sampleFormat "${sampleFormat}" unsupported (expected ${[...SAMPLE_FORMATS].join(', ')})`);
  }
  const frames = channels[0].length;
  const seconds = frames / sampleRate;
  const embed = options.embed !== false;
  const wav = encodeWav(channels, { sampleRate, format: sampleFormat });
  const sha256 = createHash('sha256').update(wav).digest('hex');
  const explicit = options.file;
  if (explicit !== undefined && (typeof explicit !== 'string' || !explicit)) {
    throw new Error(`${type}.file must be a relative WAV path inside outDir`);
  }
  const file = explicit ?? `processed/audio/${sha256}.wav`;
  if (explicit !== undefined || !embed) validateDerivedPath(ctx.outDir, file, type);
  if (!embed) writeDerivedWav(ctx.outDir, file, wav, type);
  // resolveUrl implements the common {raw}/{slot}/{file} and urlBase rules;
  // supply the derived path rather than the raw slot's saved path.
  const url = embed
    ? resolveUrl(options, ctx, slot)
    : resolveUrl({ ...options, file }, { ...ctx, saved: new Map() }, slot ?? 'result');
  const value = {
    container: 'wav',
    format: sampleFormat.startsWith('float') ? 'float' : 'pcm',
    sampleFormat,
    sampleRate,
    channels: channels.length,
    frames,
    seconds: round(seconds),
  };
  if (embed) value.data = toBase64(wav);
  else {
    value.file = file;
    value.sha256 = sha256;
    value.bytes = wav.length;
  }
  if (url !== null) value.url = url;
  value.loopStart = loopStart;
  value.loopEnd = loopEnd;
  if (loopScore !== undefined && loopScore !== null) value.loopScore = round(loopScore);
  if (crossfade) value.crossfade = round(crossfade);
  value.gain = round(gain);
  value.peak = round(peak);
  if (options.meta !== undefined && options.meta !== null) value.meta = options.meta;
  return value;
}

/** Reject traversal and symlinks at every existing component, including outDir. */
function validateDerivedPath(outDir, relative, type) {
  if (typeof outDir !== 'string' || !outDir) throw new Error(`${type}: embed:false needs outDir`);
  if (path.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.includes('\\') ||
      relative.split('/').some((part) => !part || part === '.' || part === '..') ||
      relative.split('/')[0].toLowerCase() === 'raw' || !relative.toLowerCase().endsWith('.wav')) {
    throw new Error(`${type}.file must be a relative WAV path inside outDir, outside raw/`);
  }
  const root = path.resolve(outDir);
  const check = (target) => {
    try {
      if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`${type}.file symlink escapes or redirects outDir: ${target}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  };
  let current = path.parse(root).root;
  for (const part of path.relative(current, root).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    check(current);
  }
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    check(current);
  }
  return current;
}

function writeDerivedWav(outDir, relative, wav, type) {
  const target = validateDerivedPath(outDir, relative, type);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  validateDerivedPath(outDir, relative, type);
  writeFileAtomic(target, wav);
}
