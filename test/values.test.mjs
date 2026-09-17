import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateValues, generatorTypes, generators, heightGrid, portalGrid, radialGrid, sparkGrid } from '../src/values.mjs';
import { fbm2, hash2, tileFbm, valueNoise, wrapIndex } from '../src/noise.mjs';

const isGrid = (grid, size) =>
  Array.isArray(grid) &&
  grid.length === size &&
  grid.every((row) => Array.isArray(row) && row.length === size && row.every((value) => typeof value === 'number' && value >= 0 && value <= 1));

test('height grids are non-negative, square and deterministic', () => {
  const a = heightGrid(16, 7, 'noise');
  const b = heightGrid(16, 7, 'noise');
  assert.ok(isGrid(a, 16));
  assert.deepEqual(a, b);
  assert.notDeepEqual(heightGrid(16, 8, 'noise'), a, 'seed changes the field');
  assert.notDeepEqual(heightGrid(16, 7, 'ridge'), a, 'kind changes the field');
  assert.notDeepEqual(heightGrid(16, 7, 'cells'), a, 'kind changes the field');
});

test('radial, portal and spark grids are deterministic and non-negative', () => {
  for (const [name, make] of [['radial', radialGrid], ['portal', portalGrid], ['spark', sparkGrid]]) {
    const frame0 = make(16, 0, 3);
    const frame1 = make(16, 1, 3);
    assert.ok(isGrid(frame0, 16), `${name} frame 0`);
    assert.ok(isGrid(frame1, 16), `${name} frame 1`);
    assert.deepEqual(make(16, 0, 3), frame0, `${name} is deterministic`);
    assert.notDeepEqual(frame0, frame1, `${name} changes per frame`);
  }
});

test('generateValues resolves specs through the registry', () => {
  assert.equal(generateValues({}), null);
  assert.equal(generateValues({ generateValues: {} }), null);
  const grid = generateValues({ generateValues: { type: 'height', size: 8, seed: 2 } });
  assert.ok(isGrid(grid, 8));
  assert.ok(isGrid(generateValues({ generateValues: { type: 'radial' } }), 32), 'defaults to 32px');
});

test('generateValues fails clearly on an unknown type', () => {
  assert.throws(
    () => generateValues({ generateValues: { type: 'vibes' } }),
    /unknown generateValues\.type "vibes" \(available: height, radial, portal, spark\)/,
  );
});

test('generateValues accepts a custom registry entry', () => {
  const grid = generateValues({ generateValues: { type: 'flat', size: 4 } }, { ...generators, flat: (spec) => [[spec.size]] });
  assert.deepEqual(grid, [[4]]);
  assert.ok(generatorTypes.includes('height'));
});

test('noise helpers are deterministic and in range', () => {
  for (let i = 0; i < 20; i++) {
    const value = hash2(i, i * 3, 11);
    assert.ok(value >= 0 && value < 1);
    assert.equal(hash2(i, i * 3, 11), value);
  }
  const noise = valueNoise(1.25, 3.5, 7);
  assert.equal(valueNoise(1.25, 3.5, 7), noise);
  assert.ok(noise >= 0 && noise <= 1);
  assert.ok(fbm2(2.5, 1.5, 3) >= 0 && fbm2(2.5, 1.5, 3) <= 1);
  assert.ok(tileFbm(0.1, 0.9, 5, 4) >= 0 && tileFbm(0.1, 0.9, 5, 4) <= 1);
  assert.equal(wrapIndex(-1, 8), 7);
  assert.equal(wrapIndex(9, 8), 1);
});

test('wrapping noise tiles seamlessly at the period boundary', () => {
  // Sampling just before and after the lattice edge must agree when both
  // samples wrap to the same lattice cells.
  const period = 8;
  const before = tileFbm(0.999999, 0.5, 3, period, 1);
  const after = tileFbm(1.0, 0.5, 3, period, 1);
  assert.ok(Math.abs(before - after) < 0.01, `${before} ~= ${after}`);
});
