import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { bundleRecords, summarizeRecords } from '../src/bundle.mjs';
import { decodePng } from '../src/decoders/png.mjs';
import { emitters, emitterTypes, resolveEmitters, runEmitters } from '../src/emitters/index.mjs';
import { toBase64 } from '../src/image.mjs';
import { makeTmpDir, readFixture } from './helpers.mjs';

const PIXELS = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);

const imageRecord = (overrides = {}) => ({
  job: 'tile',
  type: 'texture-tile',
  bucket: 'textures',
  key: 'rock',
  value: { width: 2, height: 2, format: 'rgba8', data: toBase64(PIXELS) },
  ...overrides,
});

const run = (records, config, outDir, extra = {}) =>
  runEmitters({ config, records, outDir, provenance: extra.provenance ?? {}, version: 1, generator: 'mothbake', log: () => {} });

test('emitter registry exposes the four built-ins and defaults to files', () => {
  assert.deepEqual(emitterTypes, ['files', 'json', 'esm', 'atlas']);
  for (const type of emitterTypes) assert.equal(typeof emitters[type], 'function');
  assert.deepEqual(
    resolveEmitters({}).map((entry) => entry.name),
    ['files'],
  );
  assert.throws(() => resolveEmitters({ emitters: ['nope'] }), /unknown emitter "nope"/);
  assert.throws(() => resolveEmitters({ emitters: [{ type: 'files' }, 42] }), /expected a name/);
});

test('bundleRecords merges frames and removes gaps', () => {
  const records = [
    imageRecord(),
    { job: 'rift', type: 'effect-frame', bucket: 'effects', key: 'rift', merge: 'frames', index: 0, fps: 10, value: { frame: 0 } },
    { job: 'rift', type: 'effect-frame', bucket: 'effects', key: 'rift', merge: 'frames', index: 2, fps: 12, value: { frame: 2 } },
  ];
  const bundle = bundleRecords(records, { version: 3, generator: 'test', provenance: { a: 1 } });
  assert.equal(bundle.version, 3);
  assert.equal(bundle.generator, 'test');
  assert.deepEqual(bundle.provenance, { a: 1 });
  assert.deepEqual(Object.keys(bundle), ['version', 'generator', 'provenance', 'textures', 'effects']);
  assert.equal(bundle.effects.rift.fps, 12);
  assert.deepEqual(bundle.effects.rift.frames, [{ frame: 0 }, { frame: 2 }]);
  assert.deepEqual(summarizeRecords(records), { textures: 1, effects: 2 });
});

test('files emitter writes decoded PNGs and an index', async (t) => {
  const outDir = makeTmpDir(t, 'files-emitter');
  const written = await run([imageRecord()], { emitters: [{ type: 'files' }] }, outDir);
  const pngPath = path.join(outDir, 'textures', 'rock.png');
  assert.ok(written.includes(pngPath));
  const image = decodePng(fs.readFileSync(pngPath));
  assert.equal(image.width, 2);
  assert.deepEqual(Buffer.from(image.data), Buffer.from(PIXELS));
  const index = JSON.parse(fs.readFileSync(path.join(outDir, 'index.json'), 'utf8'));
  assert.equal(index.files.length, 1);
  assert.deepEqual(index.files[0], { bucket: 'textures', key: 'rock', job: 'tile', type: 'texture-tile', file: 'textures/rock.png', bytes: index.files[0].bytes });
});

test('files emitter handles LUTs, structured records, frames and IR audio', async (t) => {
  const outDir = makeTmpDir(t, 'files-emitter-kinds');
  fs.mkdirSync(path.join(outDir, 'raw', 'demo'), { recursive: true });
  fs.copyFileSync(new URL('./fixtures/impulse.wav', import.meta.url), path.join(outDir, 'raw', 'demo', 'result.wav'));
  const lutSize = 2;
  const lutBytes = toBase64(new Uint8Array(lutSize * lutSize * 3).fill(128));
  const records = [
    { job: 'lut', type: 'material-lut', bucket: 'materials', key: 'iridescent', value: { size: lutSize, format: 'rgb8', r: lutBytes, t: lutBytes } },
    { job: 'rift-1', type: 'effect-frame', bucket: 'effects', key: 'rift', merge: 'frames', index: 1, fps: 10, value: { width: 2, height: 2, format: 'rgba8', data: toBase64(PIXELS) } },
    { job: 'level', type: 'level-graph', bucket: 'levels', key: 'arena', value: { rows: 2, cols: 2 } },
    { job: 'cavern', type: 'ir', bucket: 'irs', key: 'cavern', value: { file: 'raw/demo/result.wav', seconds: 4, taps: [] } },
  ];
  await run(records, { emitters: [{ type: 'files' }] }, outDir);
  assert.ok(fs.existsSync(path.join(outDir, 'materials', 'iridescent.r.png')));
  assert.ok(fs.existsSync(path.join(outDir, 'materials', 'iridescent.t.png')));
  assert.ok(fs.existsSync(path.join(outDir, 'effects', 'rift.001.png')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outDir, 'levels', 'arena.json'), 'utf8')), { rows: 2, cols: 2 });
  assert.deepEqual(fs.readFileSync(path.join(outDir, 'irs', 'cavern.wav')), readFixture('impulse.wav'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(outDir, 'irs', 'cavern.json'), 'utf8')).seconds, 4);
  const index = JSON.parse(fs.readFileSync(path.join(outDir, 'index.json'), 'utf8'));
  assert.equal(index.files.length, 6);
});

test('json emitter writes a bundle and supports shape/provenance options', async (t) => {
  const outDir = makeTmpDir(t, 'json-emitter');
  const records = [imageRecord()];
  const written = await run(records, { emitters: [{ type: 'json' }] }, outDir, { provenance: { tile: { engine: 'blur-v1' } } });
  assert.deepEqual(written, [path.join(outDir, 'mothbake.json')]);
  const bundle = JSON.parse(fs.readFileSync(path.join(outDir, 'mothbake.json'), 'utf8'));
  assert.equal(bundle.version, 1);
  assert.equal(bundle.generator, 'mothbake');
  assert.deepEqual(Object.keys(bundle.provenance), ['tile']);
  assert.equal(bundle.textures.rock.width, 2);

  const recordsDir = makeTmpDir(t, 'json-emitter-records');
  await run(records, { emitters: [{ type: 'json', file: 'records.json', shape: 'records', provenance: false }] }, recordsDir);
  const list = JSON.parse(fs.readFileSync(path.join(recordsDir, 'records.json'), 'utf8'));
  assert.ok(Array.isArray(list));
  assert.equal(list[0].bucket, 'textures');
});

test('esm emitter writes a module with a configurable export', async (t) => {
  const outDir = makeTmpDir(t, 'esm-emitter');
  const written = await run([imageRecord()], { emitters: [{ type: 'esm', file: 'baked.mjs', export: 'BAKED', header: '// custom header' }] }, outDir, {
    provenance: { tile: { engine: 'blur-v1' } },
  });
  assert.deepEqual(written, [path.join(outDir, 'baked.mjs')]);
  const text = fs.readFileSync(path.join(outDir, 'baked.mjs'), 'utf8');
  assert.ok(text.startsWith('// custom header\n'));
  assert.match(text, /export const BAKED = \{/);
  assert.match(text, /export default BAKED;\n$/);
  const module = await import(`${pathToFileURL(path.join(outDir, 'baked.mjs')).href}?test=${Date.now()}`);
  assert.equal(module.BAKED.textures.rock.width, 2);
  assert.equal(module.default, module.BAKED);
});

test('esm emitter rejects invalid identifiers and honours shape/defaultExport', async (t) => {
  const outDir = makeTmpDir(t, 'esm-emitter-options');
  await assert.rejects(() => run([imageRecord()], { emitters: [{ type: 'esm', export: '1 nope' }] }, outDir), /not a valid JavaScript identifier/);
  await run([imageRecord()], { emitters: [{ type: 'esm', file: 'plain.mjs', export: 'RECORDS', shape: 'records', defaultExport: false }] }, outDir);
  const text = fs.readFileSync(path.join(outDir, 'plain.mjs'), 'utf8');
  assert.match(text, /"bucket": "textures"/);
  assert.ok(!text.includes('export default'));
});

test('custom emitter functions receive records and ctx, and must return paths', async (t) => {
  const outDir = makeTmpDir(t, 'custom-emitter');
  const seen = [];
  const custom = (records, ctx) => {
    seen.push({ count: records.length, outDir: ctx.outDir, options: ctx.options, provenanceKeys: Object.keys(ctx.provenance) });
    const target = path.join(ctx.outDir, 'custom.txt');
    fs.writeFileSync(target, records.map((record) => record.key).join(','));
    return [target];
  };
  const written = await run([imageRecord()], { emitters: [custom] }, outDir, { provenance: { tile: {} } });
  assert.deepEqual(written, [path.join(outDir, 'custom.txt')]);
  assert.equal(fs.readFileSync(path.join(outDir, 'custom.txt'), 'utf8'), 'rock');
  assert.deepEqual(seen, [{ count: 1, outDir, options: {}, provenanceKeys: ['tile'] }]);
  await assert.rejects(() => run([imageRecord()], { emitters: [() => 'nope'] }, outDir), /must return an array/);
});

test('object emitters with their own emit method are supported', async (t) => {
  const outDir = makeTmpDir(t, 'object-emitter');
  const written = [];
  const custom = {
    name: 'object-emitter',
    options: { suffix: 'ok' },
    emit(records, ctx) {
      const target = path.join(ctx.outDir, `object.${ctx.options.suffix}`);
      fs.writeFileSync(target, String(records.length));
      written.push(target);
      return [target];
    },
  };
  await run([imageRecord()], { emitters: [custom] }, outDir);
  assert.deepEqual(written, [path.join(outDir, 'object.ok')]);
});
