import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMaterialFamily } from '../src/material-family.mjs';

const names = ['color', 'height', 'normal', 'roughness', 'wear'];
const bytes = (result, name, kind = 'candidate') => result[kind].maps[name].data;

test('procedural panel candidate and local baseline have aligned RGBA maps and exporter metadata', () => {
  const result = createMaterialFamily({ width: 33, height: 25, seed: 12 });
  assert.deepEqual(result.metadata.maps, names);
  assert.equal(result.metadata.normalConvention, 'OpenGL +Y');
  assert.equal(result.metadata.colorSpace.color, 'srgb');
  assert.match(result.metadata.mapInterpretation.roughness, /synthesis heuristic/);
  assert.match(result.metadata.mapInterpretation.wear, /not recovered physical truth/);
  for (const kind of ['candidate', 'baseline']) for (const name of names) {
    assert.equal(result[kind].width, 33);
    assert.equal(result[kind].height, 25);
    assert.equal(result[kind].metadata.variant, kind);
    const map = result[kind].maps[name];
    assert.equal(map.width, 33);
    assert.equal(map.height, 25);
    assert.equal(map.format, 'rgba8');
    assert.equal(map.colorSpace, name === 'color' ? 'srgb' : 'linear');
    assert.ok(map.data instanceof Uint8Array);
    assert.equal(map.data.length, 33 * 25 * 4);
    for (let i = 3; i < map.data.length; i += 4) assert.equal(map.data[i], 255);
    if (name === 'normal') assert.equal(map.normalConvention, 'OpenGL +Y');
  }
  assert.notDeepEqual(bytes(result, 'color'), bytes(result, 'color', 'baseline'));
  assert.ok(bytes(result, 'wear').some((v, i) => i % 4 !== 3 && v !== 0));
  assert.ok(bytes(result, 'wear', 'baseline').every((v, i) => i % 4 === 3 || v === 0));
});

test('deterministic generation, seed and every real control change map bytes', () => {
  const options = { width: 35, height: 27, seed: 7, wearCoverage: 0.6 };
  const original = createMaterialFamily(options);
  for (const name of names) assert.deepEqual(bytes(original, name), bytes(createMaterialFamily(options), name));
  for (const [changed, map] of [
    [{ seed: 8 }, 'height'],
    [{ panelDensity: 7 }, 'height'],
    [{ grainDirection: 'vertical' }, 'height'],
    [{ variationAmount: 0 }, 'height'],
    [{ reliefStrength: 6 }, 'normal'],
    [{ wearCoverage: 0 }, 'wear'],
  ]) assert.notDeepEqual(bytes(original, map), bytes(createMaterialFamily({ ...options, ...changed }), map), JSON.stringify(changed));
  assert.deepEqual(bytes(original, 'height', 'baseline'), bytes(createMaterialFamily({ ...options, panelDensity: 9, wearCoverage: 0 }), 'height', 'baseline'));
});

test('generated edges and corners match in all maps; diagnostics include measured axis and corner values', () => {
  const result = createMaterialFamily({ width: 35, height: 28, panelDensity: 5 });
  assert.equal(result.candidate.quality.seamless, true);
  for (const name of names) {
    const report = result.candidate.quality.seams[name];
    assert.equal(report.seamless, true, name);
    assert.equal(report.horizontal.max, 0, name);
    assert.equal(report.vertical.max, 0, name);
    assert.equal(report.corners.max, 0, name);
  }
});

test('source image is sampled at original resolution; edge and corner discontinuities are honestly reported', () => {
  const width = 8, height = 6;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    data.set([x * 30, y * 45, 90, 255], i);
  }
  const result = createMaterialFamily({ source: { width, height, data }, variationAmount: 0, wearCoverage: 0 });
  assert.equal(result.metadata.sourceType, 'rgba');
  assert.equal(result.baseline.maps.color.data[0], data[0]);
  assert.equal(result.baseline.maps.color.data[1], data[1]);
  assert.equal(result.baseline.quality.seamless, false);
  assert.ok(result.candidate.quality.seams.color.horizontal.max > 0);
  assert.ok(result.candidate.quality.seams.color.vertical.max > 0);
  assert.ok(result.candidate.quality.seams.color.corners.max > 0);
  assert.throws(() => createMaterialFamily({ source: { width, height, data }, width: 9 }), /dimensions\/data/);
});

test('height and structure grids are reflected in the baseline, and normals follow OpenGL +Y slope', () => {
  const heightGrid = Array.from({ length: 5 }, (_, y) => Array.from({ length: 5 }, () => y / 4));
  const result = createMaterialFamily({ heightGrid, reliefStrength: 3 });
  assert.equal(result.metadata.sourceType, 'heightGrid');
  assert.equal(bytes(result, 'height', 'baseline')[(2 * 5 + 2) * 4], 128);
  assert.ok(bytes(result, 'normal', 'baseline')[(2 * 5 + 2) * 4 + 1] < 128, 'rising down the texture gives negative tangent Y');
  assert.equal(createMaterialFamily({ structureGrid: heightGrid }).metadata.sourceType, 'structureGrid');
  assert.equal(result.baseline.quality.seamless, false);
});

test('rejects invalid dimensions, sources, controls and grids', () => {
  for (const options of [
    { width: 2 }, { panelDensity: 0 }, { panelDensity: 1.5 }, { grainDirection: 'diagonal' },
    { reliefStrength: -1 }, { wearCoverage: 2 }, { variationAmount: NaN }, { seed: 1.5 },
    { heightGrid: [[0, 1], [1]] }, { structureGrid: [[0, 2], [0, 1]] },
    { source: { width: 3, height: 3, data: new Uint8Array(3) } },
    { heightGrid: [[0, 0, 0], [0, 0, 0], [0, 0, 0]], width: 4 },
    { source: {}, heightGrid: [[0]] },
  ]) assert.throws(() => createMaterialFamily(options));
});

test('normal bytes decode to unit-length tangent vectors and all scalar channels are grayscale', () => {
  const { candidate } = createMaterialFamily({ width: 29, height: 21, reliefStrength: 8, seed: 123 });
  const normal = candidate.maps.normal.data;
  for (let i = 0; i < normal.length; i += 4) {
    const xyz = [0, 1, 2].map((c) => normal[i + c] / 255 * 2 - 1);
    assert.ok(Math.abs(Math.hypot(...xyz) - 1) < 0.015);
    assert.ok(xyz[2] > 0);
    for (const name of ['height', 'roughness', 'wear']) {
      const data = candidate.maps[name].data;
      assert.equal(data[i], data[i + 1]);
      assert.equal(data[i], data[i + 2]);
    }
  }
});
