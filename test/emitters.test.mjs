import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { bundleRecords, summarizeRecords } from '../src/bundle.mjs';
import { validateConfig } from '../src/config.mjs';
import { decodePng } from '../src/decoders/png.mjs';
import { emitters, emitterTypes, resolveEmitters, runEmitters } from '../src/emitters/index.mjs';
import { toBase64 } from '../src/image.mjs';
import { makeTmpDir, readFixture } from './helpers.mjs';
import { bakers } from '../src/bakers/index.mjs';

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

test('emitter registry exposes the built-ins and defaults to files', () => {
  assert.deepEqual(emitterTypes, ['files', 'json', 'esm', 'atlas', 'audio-pack', 'audio-pack-versioned']);
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

test('files emitter preserves material LUT HDR masters separately from previews', async (t) => {
  const outDir = makeTmpDir(t, 'files-lut-masters');
  const fragment = bakers['material-lut']({ id: 'lut' }, {
    files: new Map([['result', readFixture('lut-pack.zip')]]),
    bake: { type: 'material-lut', name: 'iridescent', size: 8 },
  });
  await run([{ job: 'lut', type: 'material-lut', ...fragment }], { emitters: [{ type: 'files' }] }, outDir);
  for (const role of ['reflectance', 'transmittance']) {
    const file = path.join(outDir, 'materials', `iridescent.${role}.hdr`);
    assert.ok(fs.existsSync(file));
    assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), fragment.value.masters[role].sha256);
  }
  const descriptor = JSON.parse(fs.readFileSync(path.join(outDir, 'materials', 'iridescent.json')));
  assert.equal(descriptor.masters.reflectance.data, undefined);
  assert.equal(descriptor.masters.reflectance.file, 'materials/iridescent.reflectance.hdr');
  assert.match(descriptor.interpretation, /not PBR/);
});

test('external audio clips and stitches export the same processed bytes as embedded audio', async (t) => {
  const outDir = makeTmpDir(t, 'external-audio-emitter');
  const processed = readFixture('impulse.wav');
  const raw = readFixture('clip-padded.wav');
  assert.notDeepEqual(processed, raw);
  fs.mkdirSync(path.join(outDir, 'raw', 'demo'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'processed'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'raw', 'demo', 'result.wav'), raw);
  fs.writeFileSync(path.join(outDir, 'processed', 'clip.wav'), processed);
  const hash = createHash('sha256').update(processed).digest('hex');
  const record = (type, key, value) => ({ job: key, type, bucket: 'audio', key, value });
  const records = [
    record('audio-clip', 'embedded', { data: processed.toString('base64'), container: 'wav', seconds: 1 }),
    record('audio-clip', 'external', { file: 'processed/clip.wav', bytes: processed.length, sha256: hash, seconds: 1 }),
    record('audio-stitch', 'stitched', { file: 'processed/clip.wav', bytes: processed.length, sha256: hash, seconds: 1 }),
  ];
  await run(records, { emitters: [{ type: 'files', dir: 'export' }, { type: 'audio-pack', dir: 'pack' }] }, outDir);
  for (const dir of ['export', 'pack']) {
    for (const key of ['embedded', 'external', 'stitched']) {
      assert.deepEqual(fs.readFileSync(path.join(outDir, dir, 'audio', `${key}.wav`)), processed);
      assert.ok(!fs.existsSync(path.join(outDir, dir, 'audio', `${key}.json`)));
    }
  }
  assert.deepEqual(fs.readFileSync(path.join(outDir, 'raw', 'demo', 'result.wav')), raw);
  const index = JSON.parse(fs.readFileSync(path.join(outDir, 'index.json'), 'utf8'));
  assert.deepEqual(index.files.map(({ file, bytes }) => ({ file, bytes })),
    ['embedded', 'external', 'stitched'].map((key) => ({ file: `export/audio/${key}.wav`, bytes: processed.length })));
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'pack', 'manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.clips), ['audio/embedded', 'audio/external', 'audio/stitched']);
  assert.equal(manifest.clips['audio/external'].file, 'audio/external.wav');
  assert.equal(manifest.clips['audio/external'].url, 'audio/external.wav');
});

test('external audio references must be present, processed and confined to outDir', async (t) => {
  const outDir = makeTmpDir(t, 'external-audio-security');
  const outside = makeTmpDir(t, 'external-audio-outside');
  fs.writeFileSync(path.join(outside, 'outside.wav'), readFixture('impulse.wav'));
  fs.mkdirSync(path.join(outDir, 'raw'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'raw', 'old.wav'), readFixture('clip-padded.wav'));
  fs.symlinkSync(outside, path.join(outDir, 'linked'));
  fs.symlinkSync(path.join(outDir, 'raw', 'old.wav'), path.join(outDir, 'raw-alias.wav'));
  const failures = [
    ['missing.wav', /file not found/],
    ['../outside.wav', /invalid external file reference/],
    [path.join(outside, 'outside.wav'), /invalid external file reference/],
    ['linked/outside.wav', /escapes outDir/],
    ['raw/old.wav', /raw audio reference/],
    ['RAW/old.wav', /raw audio reference/],
    ['raw-alias.wav', /raw audio reference/],
  ];
  for (const emitter of ['files', 'audio-pack']) {
    for (const type of ['audio-clip', 'audio-stitch']) {
      for (const [file, message] of failures) {
        const record = { job: 'clip', type, bucket: 'audio', key: 'clip', value: { file } };
        await assert.rejects(() => run([record], { emitters: [{ type: emitter, dir: emitter }] }, outDir), message);
      }
      const file = 'raw/old.wav';
      for (const [field, expected] of [['bytes', 1], ['sha256', '0'.repeat(64)]]) {
        const record = { job: 'clip', type, bucket: 'audio', key: 'clip', value: { file: 'safe.wav', [field]: expected } };
        fs.copyFileSync(path.join(outDir, file), path.join(outDir, 'safe.wav'));
        await assert.rejects(() => run([record], { emitters: [{ type: emitter, dir: emitter }] }, outDir), /mismatch/);
      }
    }
    const ir = { job: 'ir', type: 'ir', bucket: 'irs', key: 'cave', value: { file: 'linked/outside.wav' } };
    await assert.rejects(() => run([ir], { emitters: [{ type: emitter, dir: emitter }] }, outDir), /escapes outDir/);
    ir.value.file = 'missing.wav';
    await assert.rejects(() => run([ir], { emitters: [{ type: emitter, dir: emitter }] }, outDir), /file not found/);
  }
  assert.deepEqual(fs.readFileSync(path.join(outDir, 'raw', 'old.wav')), readFixture('clip-padded.wav'));
});

test('files and audio-pack confine configured paths and record targets before writing', async (t) => {
  const outDir = makeTmpDir(t, 'emitter-destination');
  const outside = makeTmpDir(t, 'emitter-outside');
  fs.symlinkSync(outside, path.join(outDir, 'linked'));
  fs.mkdirSync(path.join(outDir, 'safe'));
  fs.symlinkSync(outside, path.join(outDir, 'safe', 'alias'));
  const cases = [
    ['files', { dir: '../outside' }], ['files', { dir: '/tmp/outside' }],
    ['files', { dir: 'safe\\alias' }], ['files', { dir: 'linked' }],
    ['files', { indexFile: 'safe/alias/index.json' }], ['files', { indexFile: '../index.json' }],
    ['audio-pack', { dir: 'linked' }], ['audio-pack', { manifest: '../manifest.json' }],
    ['audio-pack', { manifest: 'safe/alias/manifest.json' }],
  ];
  for (const [type, options] of cases) {
    const record = type === 'files' ? imageRecord() : { type: 'audio-clip', bucket: 'audio', key: 'hit', value: { container: 'wav', data: readFixture('clip-pcm16.wav').toString('base64') } };
    await assert.rejects(() => run([record], { emitters: [{ type, ...options }] }, outDir), /destination|path/);
  }
  for (const type of ['files', 'audio-pack']) {
    const record = type === 'files' ? imageRecord() : { type: 'audio-clip', bucket: 'audio', key: 'hit', value: { container: 'wav', data: readFixture('clip-pcm16.wav').toString('base64') } };
    for (const overrides of [{ bucket: '../outside' }, { bucket: 'linked' }, { key: '../escape' }, { key: 'safe\\escape' }]) {
      await assert.rejects(() => run([{ ...record, ...overrides }], { emitters: [{ type }] }, outDir), /destination|record key/);
    }
  }
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.ok(validateConfig({ jobs: [], emitter: { type: 'files', dir: '../outside', indexFile: 'C:\\index.json' } }).errors.some((issue) => issue.path.endsWith('.dir')));
  assert.ok(validateConfig({ jobs: [], emitter: { type: 'audio-pack', manifest: '../manifest.json' } }).errors.some((issue) => issue.path.endsWith('.manifest')));
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
