// Value generators: deterministic offline grids that engines can consume as
// job params (`params.values`). This is how a bake stays reproducible without
// shipping a hand-authored input grid in the manifest.

import { tileFbm, fbm2 } from './noise.mjs';

/** Seamlessly tiling non-negative height field. `kind`: noise | ridge | cells. */
export function heightGrid(size = 32, seed = 1, kind = 'noise') {
  return Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x) => {
      const u = x / size;
      const v = y / size;
      let h = tileFbm(u, v, seed, 8, 5);
      if (kind === 'ridge') h = 1 - Math.abs(h * 2 - 1);
      if (kind === 'cells') h = Math.abs(Math.sin(u * Math.PI * 4) * Math.cos(v * Math.PI * 4));
      return Math.round(h * 1000) / 1000;
    }),
  );
}

/** Radial shock ring whose radius shifts with the frame index. */
export function radialGrid(size = 32, frame = 0, seed = 3) {
  const c = (size - 1) / 2;
  const radius = size * (0.18 + frame * 0.09);
  return Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x) => {
      const d = Math.hypot(x - c, y - c);
      const ring = Math.max(0, 1 - Math.abs(d - radius) / (size * 0.16));
      return Math.round((ring * 0.8 + fbm2(x * 0.3, y * 0.3, seed + frame * 17, 3) * 0.2) * 1000) / 1000;
    }),
  );
}

/** Expanding ring plus angular spokes and a hot core (opening gate). */
export function portalGrid(size = 32, frame = 0, seed = 41) {
  const c = (size - 1) / 2;
  const radius = size * (0.12 + frame * 0.13);
  return Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x) => {
      const dx = x - c;
      const dy = y - c;
      const d = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      const ring = Math.max(0, 1 - Math.abs(d - radius) / (size * 0.11));
      const core = Math.max(0, 1 - d / (size * 0.14));
      const spokes = Math.pow(Math.abs(Math.cos(angle * 3 + frame * 0.9)), 6) * Math.max(0, 1 - d / (size * 0.5));
      const noise = fbm2(x * 0.35, y * 0.35, seed + frame * 23, 3) * 0.18;
      return Math.round(Math.min(1, ring * 0.75 + spokes * 0.35 + core * 0.9 + noise) * 1000) / 1000;
    }),
  );
}

/** Bright core with radiating needle rays that broaden per frame (impact flash). */
export function sparkGrid(size = 32, frame = 0, seed = 61) {
  const c = (size - 1) / 2;
  const radius = size * (0.06 + frame * 0.16);
  return Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x) => {
      const dx = x - c;
      const dy = y - c;
      const d = Math.hypot(dx, dy) || 1e-6;
      const angle = Math.atan2(dy, dx);
      const core = Math.max(0, 1 - d / (size * (0.1 + frame * 0.03)));
      const ray = Math.pow(Math.abs(Math.sin(angle * 5 + seed)), 4) * Math.max(0, 1 - Math.abs(d - radius) / (size * 0.22));
      const noise = fbm2(x * 0.4, y * 0.4, seed + frame * 13, 2) * 0.15;
      return Math.round(Math.min(1, core + ray * 0.7 + noise) * 1000) / 1000;
    }),
  );
}

/**
 * Built-in generator registry. Custom generators can be supplied through a
 * `mothbake.config.mjs` (`generators: { myGrid: (spec) => grid }`).
 */
export const generators = {
  height: (spec) => heightGrid(spec.size ?? 32, spec.seed ?? 1, spec.kind ?? 'noise'),
  radial: (spec) => radialGrid(spec.size ?? 32, spec.frame ?? 0, spec.seed ?? 3),
  portal: (spec) => portalGrid(spec.size ?? 32, spec.frame ?? 0, spec.seed ?? 41),
  spark: (spec) => sparkGrid(spec.size ?? 32, spec.frame ?? 0, spec.seed ?? 61),
};

export const generatorTypes = Object.keys(generators);

/**
 * Resolve a job's `generateValues` spec against a generator registry.
 *
 * @returns {number[][]|null} The generated grid, or null when the job has no spec.
 */
export function generateValues(job, registry = generators) {
  const spec = job?.generateValues;
  if (!spec || !spec.type) return null;
  const generator = registry[spec.type];
  if (!generator) {
    throw new Error(`unknown generateValues.type "${spec.type}" (available: ${Object.keys(registry).join(', ')})`);
  }
  return generator(spec, job);
}
