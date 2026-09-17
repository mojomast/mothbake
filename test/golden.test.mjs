// Golden test for the ESM emitter: the generated module is byte-for-byte
// compared against a committed snapshot so any change to record shapes,
// bundle ordering or the emitter template is an explicit, reviewable diff.
//
// Regenerate with:  UPDATE_GOLDEN=1 node --test test/golden.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { bakers } from '../src/bakers/index.mjs';
import { runEmitters } from '../src/emitters/index.mjs';
import { fixtureJson, makeTmpDir, readFixture, ROOT } from './helpers.mjs';

const GOLDEN_FILE = path.join(ROOT, 'test', 'golden', 'baked.golden.mjs');
const EMITTER = { type: 'esm', file: 'baked.golden.mjs', export: 'BAKED', provenance: true };
const PROVENANCE = {
  'tile-job': { engine: 'blur-v1', jobId: 'job-fixture-tile', mode: 'emu', name: 'rock', credits: 1 },
  'sky-job': { engine: 'blur-v1', jobId: null, mode: 'emu', name: 'nebula', credits: 1 },
  'normals-job': { engine: 'blur-core-v1', jobId: null, mode: 'emu', name: 'rock', credits: 1 },
  'rift-job': { engine: 'blur-core-v1', jobId: null, mode: 'emu', name: 'rift', credits: 1 },
};

function goldenRecords() {
  const files = (...entries) => new Map(entries);
  return [
    {
      job: 'tile-job',
      type: 'texture-tile',
      ...bakers['texture-tile'](
        { id: 'tile-job' },
        { files: files(['result', readFixture('tile.png')]), bake: { type: 'texture-tile', name: 'rock', size: 8 } },
      ),
    },
    {
      job: 'sky-job',
      type: 'sky',
      ...bakers.sky(
        { id: 'sky-job' },
        { files: files(['result', readFixture('sky.png')]), bake: { type: 'sky', name: 'nebula', width: 8, height: 4 } },
      ),
    },
    {
      job: 'normals-job',
      type: 'normal-map',
      ...bakers['normal-map'](
        { id: 'normals-job' },
        { result: fixtureJson('height-grid.json'), bake: { type: 'normal-map', name: 'rock', size: 4, strength: 1.7 } },
      ),
    },
    {
      job: 'rift-job',
      type: 'effect-frame',
      ...bakers['effect-frame'](
        { id: 'rift-job' },
        { result: fixtureJson('effect-grid.json'), bake: { type: 'effect-frame', name: 'rift', index: 0, fps: 10, size: 4, tint: 'quantum' } },
      ),
    },
  ];
}

test('esm emitter output matches the committed golden module', async (t) => {
  const outDir = makeTmpDir(t, 'golden');
  await runEmitters({
    config: { emitters: [EMITTER] },
    records: goldenRecords(),
    outDir,
    provenance: PROVENANCE,
    version: 1,
    generator: 'mothbake',
    log: () => {},
  });
  const actual = fs.readFileSync(path.join(outDir, 'baked.golden.mjs'), 'utf8');
  if (process.env.UPDATE_GOLDEN === '1') {
    fs.mkdirSync(path.dirname(GOLDEN_FILE), { recursive: true });
    fs.writeFileSync(GOLDEN_FILE, actual);
  }
  assert.equal(actual, fs.readFileSync(GOLDEN_FILE, 'utf8'), 'golden mismatch — run UPDATE_GOLDEN=1 node --test test/golden.test.mjs');
});

test('the golden module is importable and carries every bucket', async () => {
  const module = await import(`${pathToFileURL(GOLDEN_FILE).href}?t=${Date.now()}`);
  const baked = module.BAKED;
  assert.equal(baked.version, 1);
  assert.equal(baked.generator, 'mothbake');
  assert.deepEqual(Object.keys(baked.provenance), Object.keys(PROVENANCE));
  assert.deepEqual(Object.keys(baked).filter((key) => !['version', 'generator', 'provenance'].includes(key)), [
    'textures',
    'sky',
    'normals',
    'effects',
  ]);
  assert.equal(baked.textures.rock.width, 8);
  assert.equal(baked.textures.rock.format, 'rgba8');
  assert.equal(baked.sky.nebula.equirect, true);
  assert.equal(baked.effects.rift.fps, 10);
  assert.equal(baked.effects.rift.frames.length, 1);
});
