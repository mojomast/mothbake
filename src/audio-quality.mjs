// Category-aware diagnostics for baked float audio. These measurements never
// modify exported samples and are suitable for display in the local workbench.

const round = (value) => Math.round(value * 1e6) / 1e6;
const CATEGORIES = new Set(['impact', 'ui', 'loop', 'ambience', 'impulse-response', 'generic']);

export function analyzeAudioQuality(channelData, sampleRate, options = {}) {
  if (!Array.isArray(channelData) || !channelData.length || !channelData.every((channel) => channel instanceof Float32Array)) throw new TypeError('audio quality needs Float32Array channels');
  const frames = channelData[0].length;
  if (!channelData.every((channel) => channel.length === frames) || !Number.isFinite(sampleRate) || sampleRate <= 0) throw new TypeError('audio quality channel/rate mismatch');
  const category = options.category ?? 'generic';
  if (!CATEGORIES.has(category)) throw new TypeError(`unknown audio category "${category}"`);
  let peak = 0, sumSquares = 0, sum = 0, clippedSamples = 0, silentSamples = 0;
  const total = Math.max(1, frames * channelData.length);
  for (const channel of channelData) for (const sample of channel) {
    const absolute = Math.abs(sample);
    peak = Math.max(peak, absolute);
    sumSquares += sample * sample;
    sum += sample;
    if (absolute >= 0.9999) clippedSamples += 1;
    if (absolute < 0.0001) silentSamples += 1;
  }
  let loopSeam = null;
  if (options.loopStart !== null && options.loopStart !== undefined && options.loopEnd !== null && options.loopEnd !== undefined) {
    const start = Math.max(0, Math.min(frames - 1, Math.round(options.loopStart * sampleRate)));
    const end = Math.max(1, Math.min(frames, Math.round(options.loopEnd * sampleRate)));
    let difference = 0;
    for (const channel of channelData) difference += Math.abs(channel[start] - channel[end - 1]);
    loopSeam = round(difference / channelData.length);
  }
  const rms = Math.sqrt(sumSquares / total);
  const dcOffset = sum / total;
  const warnings = [];
  if (peak < 0.0001) warnings.push('Signal is effectively silent.');
  if (clippedSamples) warnings.push(`${clippedSamples} sample(s) reach the clipping threshold.`);
  if (Math.abs(dcOffset) > 0.02) warnings.push('DC offset exceeds 0.02.');
  if (['loop', 'ambience'].includes(category) && loopSeam !== null && loopSeam > 0.05) warnings.push('Loop boundary discontinuity exceeds 0.05; audition repeated playback.');
  if (category === 'impulse-response' && options.normalized) warnings.push('Impulse responses are not universally peak-normalized; verify the intended gain calibration.');
  return {
    category,
    sampleRate,
    channels: channelData.length,
    frames,
    seconds: round(frames / sampleRate),
    peak: round(peak),
    rms: round(rms),
    dcOffset: round(dcOffset),
    clippedSamples,
    silentFraction: round(silentSamples / total),
    loopSeam,
    warnings,
    previewProcessing: 'none',
  };
}
