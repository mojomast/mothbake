import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bakerBuckets, bakerTypes, bakers, resolveBakers } from '../src/bakers/index.mjs';
import { fromBase64 } from '../src/image.mjs';
import { fixtureJson, readFixture } from './helpers.mjs';

const ctx = (options = {}) => ({
  files: new Map(Object.entries(options.files || {})),
  saved: new Map(Object.entries(options.saved || {})),
  result: options.result ?? null,
  bake: options.bake || {},
  job: options.job || { id: 'job-1' },
  rawName: options.rawName || 'job-1',
  outDir: options.outDir || '/tmp/out',
  configDir: options.configDir || '/tmp/config',
  log: () => {},
});

test('the registry exposes every documented baker', () => {
  assert.deepEqual(bakerTypes, [
    'texture-tile',
    'sky',
    'material-lut',
    'normal-map',
    'effect-frame',
    'level-graph',
    'motif',
    'ir',
    'seed',
    'sprite-sheet',
    'audio-clip',
    'ir-descriptor',
  ]);
  for (const type of bakerTypes) assert.equal(typeof bakers[type], 'function');
  assert.equal(bakers['ir-descriptor'], bakers.ir, 'ir-descriptor is an alias for ir');
  assert.equal(bakerBuckets['texture-tile'], 'textures');
  assert.equal(bakerBuckets['normal-map'], 'normals');
  assert.equal(bakerBuckets['ir-descriptor'], 'irs');
  assert.equal(bakerBuckets['sprite-sheet'], 'sprites');
  assert.equal(bakerBuckets['audio-clip'], 'audio');
});

test('resolveBakers merges custom bakers and rejects non-functions', () => {
  const custom = resolveBakers({ bakers: { custom: () => ({ bucket: 'x', key: 'y', value: 1 }) } });
  assert.equal(typeof custom.custom, 'function');
  assert.equal(typeof custom['texture-tile'], 'function');
  assert.throws(() => resolveBakers({ bakers: { broken: 42 } }), /must be a function/);
});

test('texture-tile downscales a PNG result into a small RGBA tile', () => {
  const record = bakers['texture-tile'](
    { id: 'rock-tile' },
    ctx({
      files: { result: readFixture('tile.png') },
      bake: { type: 'texture-tile', name: 'rock', size: 16, bucket: 'surfaces' },
    }),
  );
  assert.equal(record.bucket, 'surfaces');
  assert.equal(record.key, 'rock');
  assert.equal(record.value.width, 16);
  assert.equal(record.value.height, 16);
  assert.equal(record.value.format, 'rgba8');
  assert.equal(fromBase64(record.value.data).length, 16 * 16 * 4);
});

test('texture-tile falls back to the job id and default bucket', () => {
  const record = bakers['texture-tile'](
    { id: 'rock-tile' },
    ctx({ files: { result: readFixture('sky.png') }, bake: { type: 'texture-tile', size: 8 } }),
  );
  assert.equal(record.bucket, 'textures');
  assert.equal(record.key, 'rock-tile');
});

test('texture-tile fails clearly when the result slot is missing', () => {
  assert.throws(
    () => bakers['texture-tile']({ id: 'x' }, ctx({ bake: { type: 'texture-tile' } })),
    /output slot "result" missing \(available: none\)/,
  );
});

test('sky produces an equirectangular texture', () => {
  const record = bakers.sky(
    { id: 'nebula' },
    ctx({ files: { result: readFixture('sky.png') }, bake: { type: 'sky', name: 'nebula', width: 32, height: 16 } }),
  );
  assert.equal(record.bucket, 'sky');
  assert.equal(record.key, 'nebula');
  assert.equal(record.value.width, 32);
  assert.equal(record.value.height, 16);
  assert.equal(record.value.equirect, true);
  assert.equal(fromBase64(record.value.data).length, 32 * 16 * 4);
});

test('material-lut extracts both LUTs from a ZIP result', () => {
  const record = bakers['material-lut'](
    { id: 'lut' },
    ctx({ files: { result: readFixture('lut-pack.zip') }, bake: { type: 'material-lut', name: 'iridescent', size: 12 } }),
  );
  assert.equal(record.bucket, 'materials');
  assert.equal(record.value.size, 12);
  assert.equal(record.value.format, 'rgb8');
  assert.equal(fromBase64(record.value.r).length, 12 * 12 * 3);
  assert.equal(fromBase64(record.value.t).length, 12 * 12 * 3);
});

test('material-lut names the missing entries in its error', () => {
  assert.throws(
    () =>
      bakers['material-lut'](
        { id: 'lut' },
        ctx({ files: { result: readFixture('lut-pack.zip') }, bake: { type: 'material-lut', reflectance: 'nope.hdr', transmittance: 'also-nope.hdr' } }),
      ),
    /nope\.hdr.*not found in archive/,
  );
});

test('normal-map turns a height grid into tangent-space normals', () => {
  const record = bakers['normal-map'](
    { id: 'rock-normals' },
    ctx({ result: fixtureJson('height-grid.json'), bake: { type: 'normal-map', name: 'rock', size: 24, strength: 2 } }),
  );
  assert.equal(record.bucket, 'normals');
  assert.equal(record.value.width, 24);
  assert.equal(record.value.height, 24);
  const bytes = fromBase64(record.value.data);
  assert.equal(bytes.length, 24 * 24 * 4);
  let offCentre = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    assert.equal(bytes[i + 3], 255);
    if (bytes[i] !== 128 || bytes[i + 1] !== 128) offCentre++;
  }
  assert.ok(offCentre > 0, 'expected a non-flat normal map');
});

test('normal-map fails when the result has no grid', () => {
  assert.throws(() => bakers['normal-map']({ id: 'x' }, ctx({ result: { nope: true }, bake: { type: 'normal-map' } })), /no 2D grid/);
});

test('effect-frame returns a mergeable frame with index and fps', () => {
  const record = bakers['effect-frame'](
    { id: 'rift-2' },
    ctx({ result: fixtureJson('effect-grid.json'), bake: { type: 'effect-frame', name: 'rift', index: 2, fps: 12, size: 16, tint: 'ember' } }),
  );
  assert.equal(record.bucket, 'effects');
  assert.equal(record.key, 'rift');
  assert.equal(record.merge, 'frames');
  assert.equal(record.index, 2);
  assert.equal(record.fps, 12);
  assert.equal(fromBase64(record.value.data).length, 16 * 16 * 4);
});

test('effect-frame rejects an unknown colour ramp', () => {
  assert.throws(
    () =>
      bakers['effect-frame'](
        { id: 'x' },
        ctx({ result: fixtureJson('effect-grid.json'), bake: { type: 'effect-frame', tint: 'ultraviolet' } }),
      ),
    /ramp "ultraviolet" is not a list of colour stops/,
  );
});

test('effect-frame accepts custom ramps from config', () => {
  const record = bakers['effect-frame'](
    { id: 'x' },
    ctx({
      result: fixtureJson('effect-grid.json'),
      bake: { type: 'effect-frame', size: 4, ramp: 'brand', ramps: { brand: [[0, 0, 0], [255, 0, 0]] } },
    }),
  );
  assert.equal(fromBase64(record.value.data).length, 4 * 4 * 4);
});

test('effect-frame accepts `effect` as a key alias and `name` wins', () => {
  const withEffect = bakers['effect-frame'](
    { id: 'x' },
    ctx({ result: fixtureJson('effect-grid.json'), bake: { type: 'effect-frame', effect: 'portal', size: 4 } }),
  );
  assert.equal(withEffect.key, 'portal');
  const withBoth = bakers['effect-frame'](
    { id: 'x' },
    ctx({ result: fixtureJson('effect-grid.json'), bake: { type: 'effect-frame', name: 'rift', effect: 'portal', size: 4 } }),
  );
  assert.equal(withBoth.key, 'rift');
});

test('effect-frame bakes portal and spark generator grids', () => {
  for (const [fixture, ramp] of [
    ['portal-grid.json', 'plasma'],
    ['spark-grid.json', 'ember'],
  ]) {
    const record = bakers['effect-frame'](
      { id: 'x' },
      ctx({ result: fixtureJson(fixture), bake: { type: 'effect-frame', name: 'fx', size: 16, tint: ramp } }),
    );
    assert.equal(record.merge, 'frames');
    assert.equal(record.value.format, 'rgba8');
    assert.equal(fromBase64(record.value.data).length, 16 * 16 * 4);
  }
});

test('level-graph flattens a labyrinth result', () => {
  const record = bakers['level-graph'](
    { id: 'arena' },
    ctx({ result: fixtureJson('level-graph.json'), bake: { type: 'level-graph', name: 'arena' } }),
  );
  assert.equal(record.bucket, 'levels');
  assert.equal(record.value.rows, 4);
  assert.equal(record.value.cols, 4);
  assert.equal(record.value.cells.length, 16);
  assert.equal(record.value.numQubits, 16);
  assert.equal(record.value.coupling.length, 24);
  assert.equal(record.value.measurements.length, 8);
  assert.deepEqual(Object.keys(record.value.metrics).sort(), ['backend', 'mode', 'shots', 'szSamp']);
  assert.ok(record.value.cells.some((cell) => cell.radiating === true));
});

test('level-graph rejects unexpected result shapes', () => {
  assert.throws(() => bakers['level-graph']({ id: 'x' }, ctx({ result: { output: { nope: 1 } } })), /unexpected result shape/);
});

test('motif flattens MIDI notes into sixteenth-note steps', () => {
  const record = bakers.motif(
    { id: 'oracle' },
    ctx({ files: { result: readFixture('motif.mid') }, bake: { type: 'motif', name: 'oracle' } }),
  );
  assert.equal(record.bucket, 'motifs');
  assert.equal(record.value.bpm, 60);
  assert.equal(record.value.ppq, 480);
  assert.equal(record.value.notes.length, 16);
  for (const note of record.value.notes) {
    assert.equal(Number.isInteger(note.step), true);
    assert.ok(note.dur >= 1);
    assert.ok(note.vel > 0);
  }
});

test('motif supports transposition and a note cap', () => {
  const record = bakers.motif(
    { id: 'oracle' },
    ctx({ files: { result: readFixture('motif.mid') }, bake: { type: 'motif', maxNotes: 3, transpose: 12 } }),
  );
  assert.equal(record.value.notes.length, 3);
  assert.equal(record.value.notes[0].midi, 62 + 12);
});

test('ir describes a WAV result and extracts the tap map', () => {
  const record = bakers.ir(
    { id: 'cavern-ir' },
    ctx({
      files: { result: readFixture('impulse.wav'), taps: readFixture('impulse-taps.json') },
      saved: { result: { relative: 'raw/cavern-ir/result.wav', file: '/tmp/out/raw/cavern-ir/result.wav' } },
      rawName: 'cavern-ir',
      bake: { type: 'ir', name: 'cavern', urlBase: '/audio/irs', maxTaps: 8 },
    }),
  );
  assert.equal(record.bucket, 'irs');
  assert.equal(record.value.seconds, 4);
  assert.equal(record.value.sampleRate, 22050);
  assert.equal(record.value.channels, 2);
  assert.equal(record.value.format, 'pcm');
  assert.equal(record.value.file, 'raw/cavern-ir/result.wav');
  assert.equal(record.value.url, '/audio/irs/cavern-ir/result.wav');
  assert.equal(record.value.taps.length, 8);
  assert.equal(typeof record.value.taps[0].time_ms, 'number');
});

test('ir leaves the URL null unless the config asks for one', () => {
  const record = bakers.ir(
    { id: 'cavern-ir' },
    ctx({
      files: { result: readFixture('impulse.wav') },
      saved: { result: { relative: 'raw/cavern-ir/result.wav', file: '/tmp/out/raw/cavern-ir/result.wav' } },
      bake: { type: 'ir', name: 'cavern' },
    }),
  );
  assert.equal(record.value.url, null);
  assert.equal(record.value.taps, null);
});

test('seed records the entropy certificate when no bytes are extractable', () => {
  const record = bakers.seed(
    { id: 'daily' },
    ctx({ result: fixtureJson('randombits.json'), bake: { type: 'seed', name: 'daily' } }),
  );
  assert.equal(record.bucket, 'seeds');
  assert.equal(record.value.seed, null, 'the recorded emulator run produced zero bytes');
  assert.equal(record.value.hex, null);
  assert.equal(record.value.bytes, 0);
  assert.equal(record.value.bell, 2.812988);
  assert.equal(record.value.classicalBound, 2);
  assert.equal(typeof record.value.commitment, 'string');
  assert.equal(record.value.certificate.healthPassed, true);
  assert.equal(record.value.certificate.witnessViolatesClassical, true);
  assert.equal(record.value.mode, 'emu');
});

test('seed derives a uint32 seed when bytes are present', () => {
  const record = bakers.seed(
    { id: 'daily' },
    ctx({
      result: { output: { random: { hex: 'DEADBEEF0011', bytes: 6 }, provenance: { backend: 'ibm', mode: 'qpu' } } },
      bake: { type: 'seed', name: 'daily' },
    }),
  );
  assert.equal(record.value.seed, 0xdeadbeef);
  assert.equal(record.value.hex, 'deadbeef0011');
  assert.equal(record.value.certificate.outputBits, 48);
});
