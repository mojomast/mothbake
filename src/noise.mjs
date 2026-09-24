// Deterministic value noise shared by the procedural source-art generator and
// the blur-core value generators. Everything here is integer-hash based, so
// results are identical across platforms and runs.

/** Hash two integer coordinates plus a seed to a float in [0, 1). */
export const hash2 = (x, y, seed) => {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
};

export const smoothStep = (t) => t * t * (3 - 2 * t);

/**
 * Small deterministic PRNG (mulberry32). Returns a function producing floats in
 * [0, 1). Integer-hash based, so a seed gives identical streams everywhere.
 */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Non-wrapping 2D value noise in [0, 1]. */
export const valueNoise = (x, y, seed) => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  const u = smoothStep(xf);
  const v = smoothStep(yf);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
};

/** Fractal Brownian motion over `valueNoise`, normalized to [0, 1]. */
export const fbm2 = (x, y, seed, octaves = 4) => {
  let total = 0;
  let amplitude = 0.5;
  let frequency = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    total += valueNoise(x * frequency, y * frequency, seed + i * 131) * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return total / norm;
};

export const wrapIndex = (n, m) => ((n % m) + m) % m;
export const wrap01 = (t) => ((t % 1) + 1) % 1;

/** Clamped smoothstep shaping helper: 0 at/below `edge0`, 1 at/above `edge1`. */
export const smoothRange = (edge0, edge1, value) => {
  const span = edge1 - edge0 || 1;
  const t = Math.max(0, Math.min(1, (value - edge0) / span));
  return t * t * (3 - 2 * t);
};

/** Seamlessly tiling 2D value noise: the lattice wraps every `period` cells. */
export const valueNoiseT = (x, y, seed, period) => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const x0 = wrapIndex(xi, period);
  const x1 = wrapIndex(xi + 1, period);
  const y0 = wrapIndex(yi, period);
  const y1 = wrapIndex(yi + 1, period);
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  const u = smoothStep(xf);
  const v = smoothStep(yf);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
};

/** Seamlessly tiling fBm, normalized to [0, 1]. */
export const tileFbm = (u, v, seed, freq, octaves = 4) => {
  let total = 0;
  let amplitude = 0.5;
  let f = freq;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    total += valueNoiseT(u * f, v * f, seed + i * 131, f) * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    f *= 2;
  }
  return total / norm;
};

/**
 * Wrapping value noise with an independent lattice period per axis, so a field
 * can run long along one direction and fine along the other.
 */
export const valueNoiseXY = (x, y, seed, periodX, periodY) => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const x0 = wrapIndex(xi, periodX);
  const x1 = wrapIndex(xi + 1, periodX);
  const y0 = wrapIndex(yi, periodY);
  const y1 = wrapIndex(yi + 1, periodY);
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  const u = smoothStep(xf);
  const v = smoothStep(yf);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
};

/** Anisotropic wrapping fBm: `freqX`/`freqY` stretch the lattice per axis. */
export const tileFbmXY = (u, v, seed, freqX, freqY, octaves = 4) => {
  let total = 0;
  let amplitude = 0.5;
  let fx = freqX;
  let fy = freqY;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    total += valueNoiseXY(u * fx, v * fy, seed + i * 131, fx, fy) * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    fx *= 2;
    fy *= 2;
  }
  return total / norm;
};
