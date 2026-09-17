// Value generators: deterministic offline grids that engines can consume as
// job params (`params.values`). This is how a bake stays reproducible without
// shipping a hand-authored input grid in the manifest.

import { tileFbm, fbm2, hash2 } from './noise.mjs';

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

/** Explosion bloom: a bright turbulent core inside an expanding shock ring. */
export function bloomGrid(size = 32, frame = 0, seed = 23) {
  const c = (size - 1) / 2;
  const t = Math.min(1, frame / 2);
  const coreR = size * (0.3 + 0.08 * t);
  const ringR = size * (0.12 + 0.36 * t);
  return Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x) => {
      const d = Math.hypot(x - c, y - c);
      const core = Math.pow(Math.max(0, 1 - d / coreR), 1.3);
      const ring = Math.max(0, 1 - Math.abs(d - ringR) / (size * 0.09)) * (1 - t * 0.45);
      const turbulence = fbm2(x * 0.24, y * 0.24, seed + frame * 19, 3) * core * 0.55;
      return Math.round(Math.min(1, core + ring * 0.65 + turbulence) * 1000) / 1000;
    }),
  );
}

/** Teleport vortex: a swirling ring of arms around a bright core. */
export function vortexGrid(size = 32, frame = 0, seed = 37) {
  const c = (size - 1) / 2;
  const t = Math.min(1, frame / 2);
  const radius = size * (0.36 - 0.05 * t);
  return Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x) => {
      const dx = x - c;
      const dy = y - c;
      const d = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      const swirl = angle * 2 + d / (size * 0.16) - t * 2.4;
      const ring = Math.max(0, 1 - Math.abs(d - radius) / (size * 0.1));
      const arms = Math.pow(Math.abs(Math.cos(swirl * 1.5)), 4) * ring;
      const core = Math.pow(Math.max(0, 1 - d / (size * 0.14)), 1.4);
      const noise = fbm2(x * 0.3, y * 0.3, seed + frame * 29, 3) * 0.15;
      return Math.round(Math.min(1, ring * 0.5 + arms * 0.7 + core + noise) * 1000) / 1000;
    }),
  );
}

/** Capture ring: a thin contracting ring with radial ticks that fills inward. */
export function contractGrid(size = 32, frame = 0, seed = 53) {
  const c = (size - 1) / 2;
  const t = Math.min(1, frame / 2);
  const radius = size * (0.42 - 0.2 * t);
  return Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x) => {
      const dx = x - c;
      const dy = y - c;
      const d = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      const band = Math.max(0, 1 - Math.abs(d - radius) / (size * 0.055));
      const ticks = Math.pow(Math.abs(Math.cos(angle * 8)), 8) * Math.max(0, 1 - Math.abs(d - radius) / (size * 0.16));
      const fill = Math.pow(Math.max(0, 1 - d / radius), 2) * 0.3 * t;
      const noise = fbm2(x * 0.35, y * 0.35, seed + frame * 31, 2) * 0.1;
      return Math.round(Math.min(1, band * 0.85 + ticks * 0.6 + fill + noise) * 1000) / 1000;
    }),
  );
}

/** Heal pulse: deterministic motes rising through a soft column. */
export function riseGrid(size = 32, frame = 0, seed = 71) {
  const c = (size - 1) / 2;
  const t = frame / 3;
  const motes = [];
  for (let i = 0; i < 9; i++) {
    const mx = size * (0.14 + hash2(i, 1, seed) * 0.72);
    const phase = (hash2(i, 2, seed) + t) % 1;
    const my = size * (0.92 - phase * 0.84);
    const mr = size * (0.045 + hash2(i, 3, seed) * 0.035);
    motes.push([mx, my, mr]);
  }
  return Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x) => {
      let value = 0;
      for (const [mx, my, mr] of motes) {
        const d = Math.hypot(x - mx, y - my);
        value = Math.max(value, Math.max(0, 1 - d / mr) * 0.9);
      }
      const column = Math.max(0, 1 - Math.abs(x - c) / (size * 0.12)) * Math.max(0, 1 - y / size) * 0.18;
      return Math.round(Math.min(1, value + column) * 1000) / 1000;
    }),
  );
}

/** Shield bubble: an expanding hexagonal facet shell with bright seams. */
export function shieldGrid(size = 32, frame = 0, seed = 89) {
  const c = (size - 1) / 2;
  const t = Math.min(1, frame / 2);
  const radius = size * (0.32 + 0.05 * t);
  const hexDist = (dx, dy) => {
    let value = 0;
    for (let k = 0; k < 3; k++) value = Math.max(value, Math.abs(dx * Math.cos((k * Math.PI) / 3) + dy * Math.sin((k * Math.PI) / 3)));
    return value;
  };
  return Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x) => {
      const dx = x - c;
      const dy = y - c;
      const hd = hexDist(dx, dy);
      const angle = Math.atan2(dy, dx);
      const shell = Math.max(0, 1 - Math.abs(hd - radius) / (size * 0.07));
      const seam = Math.pow(Math.max(0, Math.cos(angle * 6)), 12) * shell;
      const fill = Math.pow(Math.max(0, 1 - hd / radius), 3) * 0.22;
      const noise = fbm2(x * 0.32, y * 0.32, seed + frame * 37, 2) * 0.08;
      return Math.round(Math.min(1, shell * 0.8 + seam * 0.5 + fill + noise) * 1000) / 1000;
    }),
  );
}

/** Weather snow: deterministic flakes drifting down and to one side. */
export function snowGrid(size = 32, frame = 0, seed = 107) {
  const drift = size * 0.06 * frame;
  const flakes = [];
  for (let i = 0; i < 26; i++) {
    const fx = (hash2(i, 5, seed) * size + drift * (0.4 + hash2(i, 7, seed) * 0.6)) % size;
    const fy = (hash2(i, 6, seed) * size + size * 0.28 * frame) % size;
    flakes.push([fx, fy, size * (0.02 + hash2(i, 8, seed) * 0.022)]);
  }
  return Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x) => {
      let value = 0;
      for (const [fx, fy, fr] of flakes) {
        const dx = Math.abs(x - fx);
        const dy = Math.abs(y - fy);
        const wrapped = Math.hypot(Math.min(dx, size - dx), Math.min(dy, size - dy));
        value = Math.max(value, Math.max(0, 1 - wrapped / fr));
      }
      return Math.round(Math.min(1, value) * 1000) / 1000;
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
  bloom: (spec) => bloomGrid(spec.size ?? 32, spec.frame ?? 0, spec.seed ?? 23),
  vortex: (spec) => vortexGrid(spec.size ?? 32, spec.frame ?? 0, spec.seed ?? 37),
  contract: (spec) => contractGrid(spec.size ?? 32, spec.frame ?? 0, spec.seed ?? 53),
  rise: (spec) => riseGrid(spec.size ?? 32, spec.frame ?? 0, spec.seed ?? 71),
  shield: (spec) => shieldGrid(spec.size ?? 32, spec.frame ?? 0, spec.seed ?? 89),
  snow: (spec) => snowGrid(spec.size ?? 32, spec.frame ?? 0, spec.seed ?? 107),
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
