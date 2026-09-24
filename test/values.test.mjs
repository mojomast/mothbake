import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  generateValues,
  generatorTypes,
  generators,
  heightGrid,
  dustGrid,
  flowGrid,
  portalGrid,
  radialGrid,
  sparkGrid,
  bloomGrid,
  vortexGrid,
  contractGrid,
  riseGrid,
  shieldGrid,
  snowGrid,
} from '../src/values.mjs';
import { fbm2, hash2, smoothRange, tileFbm, tileFbmXY, valueNoise, valueNoiseXY, wrapIndex } from '../src/noise.mjs';
import { fixtureJson } from './helpers.mjs';

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

test('height defaults reproduce the pre-knob formula byte-for-byte', () => {
  // Before the 2026-09-24 variety knobs the function sampled
  // tileFbm(u, v, seed, 8, 5) directly, with ridge as 1 - |2h - 1|. With the
  // default spec the ported version must round to the same bytes, and passing
  // the defaults explicitly must be the same as omitting the spec.
  const oldFormula = (size, seed, kind) =>
    Array.from({ length: size }, (_, y) =>
      Array.from({ length: size }, (_, x) => {
        const u = x / size;
        const v = y / size;
        let h = tileFbm(u, v, seed, 8, 5);
        if (kind === 'ridge') h = 1 - Math.abs(h * 2 - 1);
        return Math.round(h * 1000) / 1000;
      }),
    );
  for (const [size, seed, kind] of [[16, 7, 'noise'], [24, 5, 'ridge']]) {
    assert.deepEqual(heightGrid(size, seed, kind), oldFormula(size, seed, kind), `${kind} ${size}px seed ${seed}`);
  }
  assert.deepEqual(
    heightGrid(16, 7, 'noise', { freq: 8, octaves: 5, angle: 0, anisotropy: 1 }),
    heightGrid(16, 7, 'noise'),
    'explicit defaults match the default call',
  );
});

test('height variety knobs each change the field and stay bounded', () => {
  const base = heightGrid(16, 7, 'noise');
  const variants = [
    ['freq', { freq: 3 }],
    ['octaves', { octaves: 2 }],
    ['angle', { angle: 0.6 }],
    ['anisotropy', { anisotropy: 4 }],
    ['combined', { freq: 12, octaves: 3, angle: 0.4, anisotropy: 8 }],
  ];
  for (const [label, spec] of variants) {
    const grid = heightGrid(16, 7, 'noise', spec);
    assert.ok(isGrid(grid, 16), `${label} stays a 16x16 grid in [0, 1]`);
    assert.notDeepEqual(grid, base, `${label} changes the field`);
  }
  assert.ok(isGrid(heightGrid(16, 7, 'ridge', { freq: 5, octaves: 6 }), 16), 'ridge honors freq/octaves');
});

test('a quarter-turn rotation and integer anisotropy preserve the seamless wrap', () => {
  // A quarter turn is an automorphism of the sampling torus, so the grid is
  // exactly the unrotated grid turned: turned[y][x] === base[x][-y mod size].
  // That keeps the left/right and top/bottom edges wrapping exactly like the
  // unrotated field.
  const size = 16;
  const base = heightGrid(size, 7, 'noise');
  const turned = heightGrid(size, 7, 'noise', { angle: Math.PI / 2 });
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      assert.equal(turned[y][x], base[x][wrapIndex(-y, size)], `quarter turn at ${x},${y}`);
    }
  }
  // An integer anisotropy makes the field repeat every 1/k in v, so the grid
  // holds k identical vertical bands and the v seam is exact.
  const bandSize = 18;
  for (const aniso of [2, 3]) {
    const bands = heightGrid(bandSize, 7, 'noise', { anisotropy: aniso });
    for (let y = 0; y < bandSize / aniso; y++) {
      for (let x = 0; x < bandSize; x++) {
        assert.equal(bands[y][x], bands[y + bandSize / aniso][x], `anisotropy ${aniso} band at ${x},${y}`);
      }
    }
  }
});

test('seeded cells give every seed its own lattice', () => {
  // Deliberate change (2026-09-24): the cell lattice phases derive from the
  // seed, so two cell jobs no longer render the same shared lattice.
  const a = heightGrid(16, 1, 'cells');
  const b = heightGrid(16, 2, 'cells');
  assert.ok(isGrid(a, 16));
  assert.deepEqual(heightGrid(16, 23, 'cells'), heightGrid(16, 23, 'cells'));
  assert.notDeepEqual(a, b, 'cells change with the seed');
  const shared = Array.from({ length: 16 }, (_, y) =>
    Array.from({ length: 16 }, (_, x) => Math.abs(Math.sin((x / 16) * Math.PI * 4) * Math.cos((y / 16) * Math.PI * 4))),
  );
  assert.notDeepEqual(a, shared, 'cells no longer share one unseeded lattice');
});

test('dust and flow grids are deterministic, bounded, seed-sensitive and registered', () => {
  for (const [name, make, seed] of [['dust', dustGrid, 149], ['flow', flowGrid, 173]]) {
    const grid = make(16, seed);
    assert.ok(isGrid(grid, 16), `${name} is a 16x16 grid in [0, 1]`);
    assert.deepEqual(make(16, seed), grid, `${name} is deterministic`);
    assert.notDeepEqual(make(16, seed + 1), grid, `${name} changes with the seed`);
    assert.ok(isGrid(generators[name]({ size: 4 }), 4), `${name} is registered and size-parameterized`);
    assert.ok(isGrid(generators[name]({}), 64), `${name} defaults to 64px`);
  }
});

test('example generator fixtures match the ported generators byte-for-byte', () => {
  // The recorded fixtures for the generator-driven example jobs are upstream
  // output; regenerating them here must reproduce the same bytes.
  const cases = [
    ['height-ridge-grid.json', { type: 'height', size: 32, seed: 11, kind: 'ridge', freq: 5, octaves: 6 }],
    ['height-angle-grid.json', { type: 'height', size: 32, seed: 83, kind: 'noise', freq: 24, octaves: 2, angle: 0.4, anisotropy: 8 }],
    ['dust-grid.json', { type: 'dust', size: 32, seed: 149 }],
    ['flow-grid.json', { type: 'flow', size: 32, seed: 173 }],
  ];
  for (const [file, spec] of cases) {
    assert.deepEqual(generateValues({ generateValues: spec }), fixtureJson(file).output, file);
  }
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

test('effect generator grids are deterministic, bounded and change per frame', () => {
  const effectGenerators = [
    ['bloom', bloomGrid, 23],
    ['vortex', vortexGrid, 37],
    ['contract', contractGrid, 53],
    ['rise', riseGrid, 71],
    ['shield', shieldGrid, 89],
    ['snow', snowGrid, 107],
  ];
  for (const [name, make, seed] of effectGenerators) {
    const frame0 = make(16, 0, seed);
    const frame1 = make(16, 1, seed);
    assert.ok(isGrid(frame0, 16), `${name} frame 0 is a 16x16 grid in [0, 1]`);
    assert.ok(isGrid(frame1, 16), `${name} frame 1 is a 16x16 grid in [0, 1]`);
    assert.deepEqual(make(16, 0, seed), frame0, `${name} is deterministic`);
    assert.notDeepEqual(frame0, frame1, `${name} changes per frame`);
    assert.notDeepEqual(make(16, 0, seed + 1), frame0, `${name} changes with the seed`);
    assert.ok(isGrid(generators[name]({ size: 4 }), 4), `${name} is registered and size-parameterized`);
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
    /unknown generateValues\.type "vibes" \(available: height, radial, portal, spark, bloom, vortex, contract, rise, shield, snow, dust, flow\)/,
  );
});

test('generateValues accepts a custom registry entry', () => {
  const grid = generateValues({ generateValues: { type: 'flat', size: 4 } }, { ...generators, flat: (spec) => [[spec.size]] });
  assert.deepEqual(grid, [[4]]);
  for (const type of ['height', 'radial', 'portal', 'spark', 'bloom', 'vortex', 'contract', 'rise', 'shield', 'snow', 'dust', 'flow']) {
    assert.ok(generatorTypes.includes(type), `${type} is a built-in generator`);
  }
});

test('generateValues passes the whole height spec through to the knobs', () => {
  const spec = { type: 'height', size: 12, seed: 5, kind: 'ridge', freq: 3, octaves: 2, angle: 0.5, anisotropy: 4 };
  assert.deepEqual(generateValues({ generateValues: spec }), heightGrid(spec.size, spec.seed, spec.kind, spec));
  // Without a spec the registry still returns the default 32px grid.
  assert.ok(isGrid(generateValues({ generateValues: { type: 'height' } }), 32));
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
  const anisotropic = tileFbmXY(0.2, 0.7, 5, 2.2, 11, 5);
  assert.equal(tileFbmXY(0.2, 0.7, 5, 2.2, 11, 5), anisotropic);
  assert.ok(anisotropic >= 0 && anisotropic <= 1);
  assert.equal(valueNoiseXY(1.5, 2.5, 3, 8, 8), valueNoiseXY(1.5, 2.5, 3, 8, 8));
  assert.equal(smoothRange(0, 1, -1), 0);
  assert.equal(smoothRange(0, 1, 2), 1);
  assert.equal(smoothRange(0, 1, 0.5), 0.5);
});

test('wrapping noise tiles seamlessly at the period boundary', () => {
  // Sampling just before and after the lattice edge must agree when both
  // samples wrap to the same lattice cells.
  const period = 8;
  const before = tileFbm(0.999999, 0.5, 3, period, 1);
  const after = tileFbm(1.0, 0.5, 3, period, 1);
  assert.ok(Math.abs(before - after) < 0.01, `${before} ~= ${after}`);
  const anisotropicBefore = tileFbmXY(0.999999, 0.5, 3, period, 4, 1);
  const anisotropicAfter = tileFbmXY(1.0, 0.5, 3, period, 4, 1);
  assert.ok(Math.abs(anisotropicBefore - anisotropicAfter) < 0.01, `${anisotropicBefore} ~= ${anisotropicAfter}`);
});
