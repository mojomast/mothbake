import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_MOTIF, DEFAULT_SOURCE_PATTERNS, makeSourceArt, writeSources } from '../src/sources.mjs';
import { decodeMidi, decodePng } from '../src/decoders/index.mjs';
import { makeTmpDir } from './helpers.mjs';

test('makeSourceArt renders a decodable PNG at the requested size', () => {
  const png = makeSourceArt('rock', { size: 32, seed: 5 });
  const image = decodePng(png);
  assert.equal(image.width, 32);
  assert.equal(image.height, 32);
  assert.equal(image.data.length, 32 * 32 * 4);
});

test('makeSourceArt honours `wide` for equirect sources', () => {
  const image = decodePng(makeSourceArt('nebula', { size: 16, wide: 3 }));
  assert.equal(image.width, 48);
  assert.equal(image.height, 16);
});

test('makeSourceArt is deterministic', () => {
  assert.deepEqual(makeSourceArt('hazard', { size: 24 }), makeSourceArt('hazard', { size: 24 }));
});

test('every default pattern renders', () => {
  for (const name of Object.keys(DEFAULT_SOURCE_PATTERNS)) {
    const png = makeSourceArt(name, { size: 16 });
    const image = decodePng(png);
    assert.ok(image.width >= 16, name);
  }
});

test('pattern specs come from config, not code', () => {
  const custom = { pattern: 'stripes', size: 8, palette: [1, 0, 0], contrast: 0.9 };
  const png = makeSourceArt('nothing-defined', custom);
  const image = decodePng(png);
  assert.equal(image.width, 8);
  assert.ok(image.data.some((value, index) => index % 4 === 0 && value > 200));
});

test('writeSources writes selected patterns plus a motif', (t) => {
  const dir = makeTmpDir(t, 'sources');
  const written = writeSources({
    dir,
    patterns: {
      a: { size: 8, pattern: 'noise' },
      b: { size: 8, pattern: 'mesh' },
    },
    log: () => {},
  });
  assert.deepEqual(
    written.map((file) => path.basename(file)).sort(),
    ['a.png', 'b.png', 'motif.mid'],
  );
  assert.equal(decodePng(fs.readFileSync(path.join(dir, 'a.png'))).width, 8);
  const decoded = decodeMidi(fs.readFileSync(path.join(dir, 'motif.mid')));
  assert.equal(decoded.notes.length, DEFAULT_MOTIF.length);
  assert.equal(decoded.bpm, 60);
});

test('writeSources filters by wanted filenames', (t) => {
  const dir = makeTmpDir(t, 'sources-wanted');
  const written = writeSources({
    dir,
    patterns: { a: { size: 8 }, b: { size: 8 } },
    wanted: ['b.png'],
    motif: false,
    log: () => {},
  });
  assert.deepEqual(written.map((file) => path.basename(file)), ['b.png']);
});

test('writeSources honours an explicit only list and motif options', (t) => {
  const dir = makeTmpDir(t, 'sources-only');
  const written = writeSources({
    dir,
    patterns: { a: { size: 8 }, b: { size: 8 } },
    only: ['a'],
    motif: { notes: [{ tick: 0, dur: 120, midi: 60, vel: 90 }], ppq: 480, bpm: 120 },
    log: () => {},
  });
  assert.deepEqual(written.map((file) => path.basename(file)).sort(), ['a.png', 'motif.mid']);
  const decoded = decodeMidi(fs.readFileSync(path.join(dir, 'motif.mid')));
  assert.equal(decoded.bpm, 120);
  assert.equal(decoded.notes.length, 1);
});

test('writeSources rejects an unknown pattern name in `only`', (t) => {
  const dir = makeTmpDir(t, 'sources-bad');
  assert.throws(() => writeSources({ dir, patterns: { a: { size: 8 } }, only: ['missing'] }), /pattern "missing" is not defined/);
});
