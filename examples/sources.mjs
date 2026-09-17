#!/usr/bin/env node
// Procedural source-art demo. Runs fully offline and deterministically: image
// engines consume PNGs as inputs, and this script renders them from wrapping
// value noise instead of hand-authored art.
//
//   node examples/sources.mjs [outDir]     # default: examples/generated
//
// The same generator is what `mothbake sources` writes, but driven directly
// here so the API is easy to read. See DEFAULT_SOURCE_PATTERNS in
// src/sources.mjs for the full pattern catalogue.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSourceArt, writeSources } from '../src/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(process.argv[2] ?? path.join(here, 'generated'));

// A small material set: one seamless natural noise, one star band for skies,
// and three industrial patterns with hard edges.
const patterns = {
  rock: { size: 256, palette: [0.5, 0.46, 0.4], pattern: 'noise', contrast: 0.7, seed: 11 },
  nebula: { size: 256, wide: 2, palette: [0.26, 0.3, 0.5], pattern: 'stars', contrast: 0.6, seed: 23 },
  grating: { size: 256, palette: [0.58, 0.61, 0.65], pattern: 'grating', cells: 8, contrast: 0.6, seed: 41 },
  carbon: { size: 256, palette: [0.22, 0.24, 0.28], pattern: 'weave', cells: 18, contrast: 0.6, seed: 47 },
  hazard: { size: 256, palette: [0.86, 0.7, 0.16], pattern: 'stripes', contrast: 0.55, seed: 53 },
};

const written = writeSources({
  dir: outDir,
  patterns,
  motif: { ppq: 480, bpm: 60 },
  log: (message) => console.log(message),
});

// Single-shot rendering with per-call overrides, for one-off experiments.
fs.mkdirSync(outDir, { recursive: true });
const custom = makeSourceArt('rock', { palette: [0.6, 0.5, 0.35], contrast: 0.9, seed: 99 });
const customPath = path.join(outDir, 'rock-warm.png');
fs.writeFileSync(customPath, custom);
written.push(customPath);
console.log(`wrote ${customPath}`);

console.log(`\n${written.length} file(s) in ${outDir}`);
