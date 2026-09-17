// Procedural source-art generator. Image engines consume PNGs as inputs;
// rendering them locally from wrapping value noise keeps art iteration free
// (no API key, no credits) and deterministic across machines.
//
// A pattern spec is a plain object, so it survives JSON:
//   { size, wide, palette: [r, g, b], contrast, freq, seed,
//     pattern: noise | panels | rivets | circuit | stripes | corrugated |
//              grating | diamond | weave | mesh | stars,
//     panels, ribs, cells, cloudFreq, starDensity }
//
// Palette entries are 0..1 multipliers; the renderer scales luminance into
// roughly 0..1.2 of the palette so bright patterns can clip on purpose.

import fs from 'node:fs';
import path from 'node:path';
import { encodePng } from './decoders/png.mjs';
import { encodeMidi } from './decoders/midi.mjs';
import { hash2, tileFbm, wrap01 } from './noise.mjs';

export const DEFAULT_SOURCE_PATTERNS = {
  panel: { size: 256, palette: [0.62, 0.66, 0.72], pattern: 'noise', contrast: 0.45 },
  tile: { size: 64, palette: [0.55, 0.6, 0.66], pattern: 'noise', contrast: 0.45 },
  rock: { size: 256, palette: [0.5, 0.46, 0.4], pattern: 'noise', contrast: 0.7 },
  sand: { size: 256, palette: [0.8, 0.71, 0.5], pattern: 'noise', contrast: 0.22 },
  ice: { size: 256, palette: [0.68, 0.82, 0.96], pattern: 'noise', contrast: 0.3 },
  grass: { size: 256, palette: [0.32, 0.5, 0.28], pattern: 'noise', contrast: 0.42 },
  metal: { size: 256, palette: [0.64, 0.67, 0.72], pattern: 'noise', contrast: 0.22 },
  hull: { size: 256, palette: [0.26, 0.32, 0.42], pattern: 'panels', contrast: 0.5 },
  circuit: { size: 256, palette: [0.18, 0.42, 0.32], pattern: 'circuit', contrast: 0.6 },
  chitin: { size: 256, palette: [0.4, 0.72, 0.66], pattern: 'noise', contrast: 0.5 },
  hazard: { size: 256, palette: [0.86, 0.7, 0.16], pattern: 'stripes', contrast: 0.55 },
  nebula: { size: 256, wide: 2, palette: [0.26, 0.3, 0.5], pattern: 'stars', contrast: 0.6 },
  macro: { size: 256, palette: [0.62, 0.58, 0.5], pattern: 'noise', contrast: 0.95, freq: 2 },
  steel: { size: 256, palette: [0.6, 0.63, 0.68], pattern: 'panels', panels: 6, contrast: 0.4, seed: 17 },
  stucco: { size: 256, palette: [0.82, 0.78, 0.7], pattern: 'noise', contrast: 0.24, freq: 7, seed: 137 },
  corrugated: { size: 256, palette: [0.62, 0.66, 0.71], pattern: 'corrugated', ribs: 12, contrast: 0.5, seed: 37 },
  grating: { size: 256, palette: [0.58, 0.61, 0.65], pattern: 'grating', cells: 8, contrast: 0.6, seed: 41 },
  diamond: { size: 256, palette: [0.6, 0.63, 0.67], pattern: 'diamond', cells: 5, contrast: 0.6, seed: 43 },
  carbon: { size: 256, palette: [0.22, 0.24, 0.28], pattern: 'weave', cells: 18, contrast: 0.6, seed: 47 },
  riveted: { size: 256, palette: [0.56, 0.6, 0.65], pattern: 'rivets', panels: 4, contrast: 0.45, seed: 53 },
  mesh: { size: 256, palette: [0.54, 0.58, 0.62], pattern: 'mesh', cells: 6, contrast: 0.7, seed: 59 },
  'sky-ashen': { size: 256, wide: 2, palette: [0.58, 0.5, 0.42], pattern: 'stars', contrast: 0.5, cloudFreq: 3.2, starDensity: 0.997, seed: 139 },
  'sky-frost': { size: 256, wide: 2, palette: [0.5, 0.62, 0.82], pattern: 'stars', contrast: 0.5, cloudFreq: 3.4, starDensity: 0.997, seed: 67 },
  'sky-void': { size: 256, wide: 2, palette: [0.26, 0.26, 0.42], pattern: 'stars', contrast: 0.5, cloudFreq: 3.6, starDensity: 0.997, seed: 149 },
};

/**
 * Render one source pattern to a PNG buffer.
 *
 * @param {string} name Pattern name, used to look up defaults.
 * @param {object} [spec] Overrides merged over the named default.
 * @param {{ patterns?: Record<string, object> }} [options]
 * @returns {Buffer} PNG bytes.
 */
export function makeSourceArt(name, spec = {}, options = {}) {
  const patterns = options.patterns ?? DEFAULT_SOURCE_PATTERNS;
  const merged = { ...(patterns[name] || {}), ...spec };
  const seed = merged.seed ?? 7;
  const size = merged.size ?? 256;
  const width = merged.wide ? size * merged.wide : size;
  const height = size;
  const [pr, pg, pb] = merged.palette || [0.6, 0.6, 0.6];
  const contrast = merged.contrast ?? 0.4;
  const freq = merged.freq ?? 6;
  const industrial = merged.pattern !== 'noise' && merged.pattern !== 'stars';
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const v = y / height;
      let lum = 0.5 + (tileFbm(u, v, seed, freq, 4) - 0.5) * contrast;
      lum += (tileFbm(u, v, seed + 31, freq * 3, 3) - 0.5) * contrast * 0.35;
      if (merged.pattern === 'panels') {
        const panels = merged.panels ?? 8;
        const gx = Math.abs(((x / width) * panels) % 1 - 0.5) * 2;
        const gy = Math.abs(((y / height) * panels) % 1 - 0.5) * 2;
        lum *= gx > 0.94 || gy > 0.94 ? 0.45 : 1;
      } else if (merged.pattern === 'rivets') {
        const panels = merged.panels ?? 4;
        const lx = ((x / width) * panels) % 1;
        const ly = ((y / height) * panels) % 1;
        const seam = Math.min(lx, 1 - lx, ly, 1 - ly);
        if (seam < 0.05) lum *= 0.45;
        const boltX = Math.abs(((ly * 4) % 1) - 0.5) < 0.12 && Math.min(lx, 1 - lx) < 0.16;
        const boltY = Math.abs(((lx * 4) % 1) - 0.5) < 0.12 && Math.min(ly, 1 - ly) < 0.16;
        if (boltX || boltY) lum = Math.min(1, lum + 0.5);
      } else if (merged.pattern === 'circuit') {
        const gx = Math.abs(((x / width) * 10) % 1 - 0.5) * 2;
        const gy = Math.abs(((y / height) * 10) % 1 - 0.5) * 2;
        if (gx > 0.96 || gy > 0.96) lum = Math.min(1, lum + 0.5);
      } else if (merged.pattern === 'stripes') {
        lum = (((x + y) / height) * 4) % 1 < 0.5 ? lum + 0.25 : lum * 0.35;
      } else if (merged.pattern === 'corrugated') {
        const ribs = merged.ribs ?? 10;
        const wave = 0.5 + 0.5 * Math.sin(u * Math.PI * 2 * ribs);
        lum = lum * (0.45 + wave * 0.75) + wave * 0.16;
      } else if (merged.pattern === 'grating') {
        const cells = merged.cells ?? 8;
        const fx = (u * cells) % 1;
        const fy = (v * cells) % 1;
        const bar = Math.min(fx, 1 - fx, fy, 1 - fy) < 0.18;
        lum = bar ? 0.6 + lum * 0.5 : lum * 0.28;
      } else if (merged.pattern === 'diamond') {
        const cells = merged.cells ?? 5;
        const t1 = wrap01(((x + y) / size) * cells);
        const t2 = wrap01(((x - y) / size) * cells);
        const tread = Math.min(t1, 1 - t1, t2, 1 - t2);
        lum = tread < 0.24 ? 0.7 + lum * 0.45 : lum * 0.5;
      } else if (merged.pattern === 'weave') {
        const cells = merged.cells ?? 16;
        const cx = Math.floor(u * cells);
        const cy = Math.floor(v * cells);
        const fx = (u * cells) % 1;
        const twill = (cx + cy) % 2 === 0 ? fx : 1 - fx;
        lum = 0.3 + twill * 0.5 + (((y / height) * cells) % 1) * 0.12 + (lum - 0.5) * 0.3;
      } else if (merged.pattern === 'mesh') {
        const cells = merged.cells ?? 6;
        const a = wrap01(((x + y) / size) * cells);
        const b = wrap01(((x - y) / size) * cells);
        const strand = a < 0.3 || b < 0.3;
        lum = strand ? 0.6 + lum * 0.4 : lum * 0.22;
      } else if (merged.pattern === 'stars') {
        const band = Math.max(0, 1 - Math.abs(y / height - 0.5) * 2.2);
        lum = 0.06 + band * (0.25 + tileFbm(u, v, seed, merged.cloudFreq ?? 3, 4) * 0.7);
        if (hash2(x * 3 + 1, y * 7 + 5, seed + 991) > (merged.starDensity ?? 0.9965)) lum = 1;
      }
      // Natural surfaces must read as one continuous material, so they are
      // rendered slightly darker than industrial patterns that keep hard edges.
      const scale = industrial ? 360 : 300;
      const i = (y * width + x) * 3;
      rgb[i] = Math.max(0, Math.min(255, Math.round(lum * pr * scale)));
      rgb[i + 1] = Math.max(0, Math.min(255, Math.round(lum * pg * scale)));
      rgb[i + 2] = Math.max(0, Math.min(255, Math.round(lum * pb * scale)));
    }
  }
  return encodePng(width, height, rgb);
}

/**
 * A short original motif used when a config asks for `sources.motif` without
 * providing notes: slow modal material for sequencer engines to rework.
 * Note numbers: A3=57, C4=60, E4=64, G4=67, A4=69, B4=71.
 */
export const DEFAULT_MOTIF = [
  { tick: 0, dur: 960, midi: 57, vel: 82 },
  { tick: 960, dur: 480, midi: 64, vel: 74 },
  { tick: 1440, dur: 960, midi: 67, vel: 86 },
  { tick: 2400, dur: 480, midi: 64, vel: 70 },
  { tick: 2880, dur: 1440, midi: 57, vel: 78 },
  { tick: 4320, dur: 480, midi: 60, vel: 72 },
  { tick: 4800, dur: 960, midi: 64, vel: 76 },
  { tick: 5760, dur: 1440, midi: 69, vel: 88 },
];

function desiredFile(name) {
  return `${name}.png`;
}

/**
 * Write source art (and optionally a motif MIDI file) to a directory.
 *
 * @param {{
 *   dir: string,
 *   patterns?: Record<string, object>,
 *   only?: string[],
 *   wanted?: Iterable<string>,
 *   motif?: false | {notes?: Array, ppq?: number, bpm?: number},
 *   log?: (message: string) => void,
 * }} options
 * @returns {string[]} Paths written.
 */
export function writeSources(options) {
  const {
    dir,
    patterns = DEFAULT_SOURCE_PATTERNS,
    only,
    wanted,
    motif = { notes: DEFAULT_MOTIF, ppq: 480, bpm: 60 },
    log = () => {},
  } = options;
  fs.mkdirSync(dir, { recursive: true });
  const wantedSet = wanted ? new Set(wanted) : null;
  const filter = wantedSet && wantedSet.size > 0 ? wantedSet : null;
  const names = only && only.length ? only : Object.keys(patterns);
  const written = [];
  for (const name of names) {
    if (!patterns[name]) throw new Error(`sources: pattern "${name}" is not defined`);
    const file = desiredFile(name);
    if (filter && !filter.has(file)) continue;
    const target = path.join(dir, file);
    fs.writeFileSync(target, makeSourceArt(name, {}, { patterns }));
    written.push(target);
    log(`wrote ${target}`);
  }
  if (motif && motif !== false) {
    const file = 'motif.mid';
    if (!filter || filter.has(file)) {
      const target = path.join(dir, file);
      fs.writeFileSync(target, encodeMidi(motif.notes || DEFAULT_MOTIF, { ppq: motif.ppq ?? 480, bpm: motif.bpm ?? 60 }));
      written.push(target);
      log(`wrote ${target}`);
    }
  }
  return written;
}
