// Publication hardening: atomic writes, exact-JSON validation, merge-safe
// publication and validated downloads. Fully offline — temp dirs and recorded
// fixtures only.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createApi, normalizeContentType } from '../src/api.mjs';
import { runEmitters } from '../src/emitters/index.mjs';
import { toBase64 } from '../src/image.mjs';
import {
  assertJsonSafe,
  mergeBundles,
  mergeIndex,
  mergeRecordLists,
  mergeRecordsIntoBundle,
  readJsonArtifact,
  validateForPublish,
  writeFileAtomic,
} from '../src/publish.mjs';
import { runConfig } from '../src/runner.mjs';
import { fixture, makeTmpDir, ROOT, runCli } from './helpers.mjs';

const PIXELS = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);

const imageRecord = (overrides = {}) => ({
  job: 'tile',
  type: 'texture-tile',
  bucket: 'textures',
  key: 'rock',
  value: { width: 2, height: 2, format: 'rgba8', data: toBase64(PIXELS) },
  ...overrides,
});

const skyRecord = {
  job: 'sky',
  type: 'sky',
  bucket: 'sky',
  key: 'nebula',
  value: { width: 2, height: 2, format: 'rgba8', data: toBase64(PIXELS), equirect: true },
};

const runEmittersFor = (records, config, outDir, extra = {}) =>
  runEmitters({
    config,
    records,
    outDir,
    provenance: extra.provenance ?? {},
    version: extra.version ?? 1,
    generator: extra.generator ?? 'mothbake',
    log: () => {},
  });

const read = (file) => fs.readFileSync(file, 'utf8');
const tempFiles = (dir) => fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
const listFiles = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? listFiles(full) : [full];
    })
    .sort();

test('writeFileAtomic replaces files, creates parents and leaves no temp files', (t) => {
  const dir = makeTmpDir(t, 'publish-atomic');
  const target = path.join(dir, 'nested', 'artifact.json');
  writeFileAtomic(target, 'one');
  assert.equal(read(target), 'one');
  writeFileAtomic(target, 'two');
  assert.equal(read(target), 'two');
  assert.deepEqual(tempFiles(path.join(dir, 'nested')), []);

  // A failure after the temp file exists must clean it up and keep the target.
  const blocked = path.join(dir, 'blocked.json');
  fs.mkdirSync(blocked);
  assert.throws(() => writeFileAtomic(blocked, 'nope'));
  assert.ok(fs.statSync(blocked).isDirectory(), 'the existing target is untouched');
  assert.deepEqual(tempFiles(dir), [], 'no temp file is left behind');
});

test('assertJsonSafe accepts exact JSON and rejects what JSON.stringify would mangle', () => {
  const value = { a: [1, 'two', null, true, -0.5], nested: { ok: {} } };
  assert.equal(assertJsonSafe(value, 'test'), value);

  const cyclic = { name: 'loop' };
  cyclic.self = cyclic;
  const holey = [1];
  holey[2] = 3;

  const cases = [
    [undefined, /is undefined, which JSON cannot represent/],
    [NaN, /is NaN, which JSON would turn into null/],
    [Infinity, /\$ is Infinity/],
    [-Infinity, /\$ is -Infinity/],
    [10n, /is a bigint, which JSON cannot represent/],
    [{ fn: () => {} }, /\$\.fn is a function/],
    [{ missing: undefined }, /\$\.missing is undefined, so JSON would drop it/],
    [holey, /\$\[1\] is a hole/],
    [new Date(), /is not a plain object/],
    [new Map(), /is not a plain object/],
    [cyclic, /is a cycle/],
    [{ [Symbol('key')]: 1 }, /enumerable symbol key/],
  ];
  for (const [sample, pattern] of cases) {
    assert.throws(() => assertJsonSafe(sample, 'test'), pattern);
  }
});

test('readJsonArtifact distinguishes missing, valid and corrupt artifacts', (t) => {
  const dir = makeTmpDir(t, 'publish-read');
  const target = path.join(dir, 'bundle.json');
  assert.equal(readJsonArtifact(target, 'test'), null);
  fs.writeFileSync(target, '{"ok":true}\n');
  assert.deepEqual(readJsonArtifact(target, 'test'), { ok: true });
  fs.writeFileSync(target, '{nope');
  assert.throws(() => readJsonArtifact(target, 'test'), /test: previous artifact is not valid JSON/);
});

test('mergeBundles preserves previous keys and merges frames by index', () => {
  const previous = {
    version: 1,
    generator: 'mothbake',
    provenance: { a: { engine: 'e1' } },
    textures: { rock: { v: 1 }, sky: { v: 2 } },
    effects: { rift: { fps: 10, frames: [{ frame: 0 }, { frame: 1 }] } },
  };
  const fresh = {
    version: 2,
    generator: 'mothbake',
    provenance: { b: { engine: 'e2' } },
    textures: { rock: { v: 9 } },
    effects: { rift: { fps: 12, frames: [{ frame: 'new-1' }] } },
  };
  const merged = mergeBundles(previous, fresh);
  assert.equal(merged.version, 2);
  assert.deepEqual(merged.textures, { rock: { v: 9 }, sky: { v: 2 } });
  assert.equal(merged.effects.rift.fps, 12);
  assert.deepEqual(merged.effects.rift.frames, [{ frame: 'new-1' }, { frame: 1 }]);
  assert.deepEqual(Object.keys(merged.provenance), ['a', 'b']);
  assert.equal(mergeBundles(null, fresh), fresh);
  assert.equal(mergeBundles(previous, null), previous);
});

test('mergeRecordsIntoBundle keeps unrelated keys and frame positions', () => {
  const previous = {
    version: 1,
    generator: 'mothbake',
    provenance: { a: { engine: 'e1' } },
    textures: { rock: { v: 1 } },
    effects: { rift: { fps: 10, frames: [{ frame: 0 }, { frame: 1 }, { frame: 2 }] } },
  };
  const records = [
    { job: 'tile', type: 'texture-tile', bucket: 'textures', key: 'rock', value: { v: 2 } },
    { job: 'rift', type: 'effect-frame', bucket: 'effects', key: 'rift', merge: 'frames', index: 1, fps: 12, value: { frame: 'new-1' } },
    { job: 'rift', type: 'effect-frame', bucket: 'effects', key: 'rift', merge: 'frames', index: 4, fps: 12, value: { frame: 'new-4' } },
  ];
  const merged = mergeRecordsIntoBundle(previous, records, { version: 1, generator: 'mothbake', provenance: { b: { engine: 'e2' } } });
  assert.deepEqual(merged.textures.rock, { v: 2 });
  assert.deepEqual(merged.effects.rift.frames, [{ frame: 0 }, { frame: 'new-1' }, { frame: 2 }, null, { frame: 'new-4' }]);
  assert.equal(merged.effects.rift.fps, 12);
  assert.deepEqual(Object.keys(merged.provenance), ['a', 'b']);

  // With no previous bundle the result is exactly the fresh bundle.
  const freshOnly = mergeRecordsIntoBundle(null, [records[1], records[2]]);
  assert.deepEqual(freshOnly.effects.rift.frames, [{ frame: 'new-1' }, { frame: 'new-4' }]);

  // `provenance: false` style replacement instead of a union.
  const without = mergeRecordsIntoBundle(previous, records, { provenance: {}, keepProvenance: false });
  assert.deepEqual(without.provenance, {});
});

test('mergeRecordLists replaces groups and merges frame groups by index', () => {
  const previous = [
    { job: 'tile', type: 'texture-tile', bucket: 'textures', key: 'rock', value: { v: 1 } },
    { job: 'rift', type: 'effect-frame', bucket: 'effects', key: 'rift', merge: 'frames', index: 0, value: { frame: 0 } },
    { job: 'rift', type: 'effect-frame', bucket: 'effects', key: 'rift', merge: 'frames', index: 1, value: { frame: 1 } },
  ];
  const fresh = [{ job: 'rift', type: 'effect-frame', bucket: 'effects', key: 'rift', merge: 'frames', index: 1, value: { frame: 'new' } }];
  const merged = mergeRecordLists(previous, fresh);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].value.frame, 0);
  assert.equal(merged[0].index, 0);
  assert.deepEqual(merged[1].value, { frame: 'new' });
  assert.equal(merged[2].bucket, 'textures', 'untouched groups are appended');

  const replaced = mergeRecordLists(previous, [{ job: 'tile', type: 'texture-tile', bucket: 'textures', key: 'rock', value: { v: 2 } }]);
  assert.equal(replaced.length, 3);
  assert.deepEqual(replaced[0].value, { v: 2 });
  assert.equal(mergeRecordLists(null, fresh), fresh);
});

test('mergeIndex keeps previous file entries and unions provenance', () => {
  const previous = {
    version: 1,
    generator: 'mothbake',
    provenance: { a: {} },
    files: [{ file: 'textures/rock.png' }, { file: 'sky/nebula.png' }],
  };
  const fresh = { version: 1, generator: 'mothbake', provenance: { b: {} }, files: [{ file: 'textures/rock.png', bytes: 4 }] };
  const merged = mergeIndex(previous, fresh);
  assert.deepEqual(merged.files.map((entry) => entry.file), ['textures/rock.png', 'sky/nebula.png']);
  assert.equal(merged.files[0].bytes, 4);
  assert.deepEqual(Object.keys(merged.provenance), ['a', 'b']);
  assert.equal(mergeIndex(null, fresh), fresh);
});

test('validateForPublish refuses an incomplete or non-JSON aggregate', () => {
  const bundle = { version: 1, generator: 'mothbake', provenance: { a: {} }, textures: { rock: { v: 1 } } };
  assert.equal(validateForPublish(bundle, { expectedProvenance: ['a'], label: 'bundle' }), bundle);
  assert.throws(
    () => validateForPublish({ ...bundle }, { expectedProvenance: ['b'], label: 'bundle' }),
    /provenance is missing a record for successful job "b"/,
  );
  assert.throws(() => validateForPublish({ ...bundle, provenance: [] }, { label: 'bundle' }), /"provenance" must be a plain object/);
  assert.throws(() => validateForPublish({ ...bundle, textures: { rock: { bad: NaN } } }, { label: 'bundle' }), /which JSON would turn into null/);
  assert.throws(() => validateForPublish([], { label: 'bundle' }), /aggregate must be a plain object/);
});

test('json emitter merge:true preserves previously published keys and provenance', async (t) => {
  const outDir = makeTmpDir(t, 'publish-json-merge');
  const config = { emitters: [{ type: 'json', file: 'bundle.json', merge: true }] };
  await runEmittersFor([imageRecord(), skyRecord], config, outDir, { provenance: { tile: { engine: 'e1' }, sky: { engine: 'e2' } } });
  await runEmittersFor([imageRecord({ value: { v: 2 } })], config, outDir, { provenance: { tile: { engine: 'e1b' } } });

  const bundle = JSON.parse(read(path.join(outDir, 'bundle.json')));
  assert.deepEqual(bundle.textures.rock, { v: 2 });
  assert.deepEqual(bundle.sky.nebula, skyRecord.value);
  assert.deepEqual(bundle.provenance, { tile: { engine: 'e1b' }, sky: { engine: 'e2' } });
  assert.deepEqual(tempFiles(outDir), []);
});

test('aggregate emitters replace their artifact unless merge is opted in', async (t) => {
  const outDir = makeTmpDir(t, 'publish-json-replace');
  await runEmittersFor([imageRecord(), skyRecord], { emitters: [{ type: 'json', file: 'bundle.json', merge: true }] }, outDir, {
    provenance: { tile: {}, sky: {} },
  });
  await runEmittersFor([imageRecord()], { emitters: [{ type: 'json', file: 'bundle.json' }] }, outDir, { provenance: { tile: {} } });

  const bundle = JSON.parse(read(path.join(outDir, 'bundle.json')));
  assert.equal(bundle.sky, undefined, 'without merge the artifact is replaced, exactly as before');
  assert.deepEqual(bundle.provenance, { tile: {} });
});

test('a failed validation leaves the previous artifact byte-identical', async (t) => {
  const outDir = makeTmpDir(t, 'publish-json-invalid');
  const config = { emitters: [{ type: 'json', file: 'bundle.json', merge: true }] };
  await runEmittersFor([imageRecord()], config, outDir, { provenance: { tile: {} } });
  const before = read(path.join(outDir, 'bundle.json'));

  await assert.rejects(
    () => runEmittersFor([{ ...imageRecord(), value: { width: 2, height: 2, broken: undefined } }], config, outDir, { provenance: { tile: {} } }),
    /is undefined, so JSON would drop it/,
  );
  assert.equal(read(path.join(outDir, 'bundle.json')), before);
  assert.deepEqual(tempFiles(outDir), []);
});

test('merge refuses to replace a corrupt previous artifact', async (t) => {
  const outDir = makeTmpDir(t, 'publish-json-corrupt');
  fs.writeFileSync(path.join(outDir, 'bundle.json'), '{not json');
  await assert.rejects(
    () => runEmittersFor([imageRecord()], { emitters: [{ type: 'json', file: 'bundle.json', merge: true }] }, outDir, { provenance: { tile: {} } }),
    /previous artifact is not valid JSON/,
  );
  assert.equal(read(path.join(outDir, 'bundle.json')), '{not json');
});

test('failed jobs keep their previous records and a run with no records writes nothing', async (t) => {
  const dir = makeTmpDir(t, 'publish-run-failures');
  const outDir = path.join(dir, 'out');
  const emitters = [
    { type: 'json', file: 'bundle.json', merge: true },
    { type: 'esm', file: 'baked.mjs', export: 'BAKED', merge: true },
  ];
  const tileJob = {
    id: 'tile',
    engine: 'blur-v1',
    raw: 'tile',
    recorded: { outputs: { result: fixture('tile.png') } },
    bake: { type: 'texture-tile', name: 'rock', size: 8 },
  };
  const skyJob = {
    id: 'sky',
    engine: 'blur-v1',
    raw: 'sky',
    recorded: { outputs: { result: fixture('sky.png') } },
    bake: { type: 'sky', name: 'nebula', width: 8, height: 4 },
  };
  const config = { version: 1, jobs: [tileJob, skyJob], emitters };
  const first = await runConfig({ config, configDir: dir, outDir, log: () => {} });
  assert.deepEqual(first.failures, []);

  // The sky job fails while the tile re-bakes at a smaller size: the merged
  // artifact must carry the new tile and the previous sky record.
  const partial = {
    ...config,
    jobs: [
      { ...tileJob, bake: { ...tileJob.bake, size: 4 } },
      { ...skyJob, recorded: { outputs: { result: 'missing.png' } } },
    ],
  };
  const partialResult = await runConfig({ config: partial, configDir: dir, outDir, log: () => {} });
  assert.equal(partialResult.failures.length, 1);
  assert.equal(partialResult.failures[0].id, 'sky');
  const bundle = JSON.parse(read(path.join(outDir, 'bundle.json')));
  assert.equal(bundle.textures.rock.width, 4, 'the successful job replaced its own record');
  assert.ok(bundle.sky.nebula, 'the failed job kept its previous record');
  assert.ok(bundle.provenance.sky, 'and its provenance');
  const module = await import(`${pathToFileURL(path.join(outDir, 'baked.mjs')).href}?t=${Date.now()}`);
  assert.ok(module.BAKED.sky.nebula);

  const bundleAfterPartial = read(path.join(outDir, 'bundle.json'));
  const moduleAfterPartial = read(path.join(outDir, 'baked.mjs'));

  // No successful records at all: the emitters never run, so both artifacts
  // stay byte-identical.
  const allFailed = { ...config, jobs: [{ ...tileJob, recorded: { outputs: { result: 'missing.png' } } }] };
  const empty = await runConfig({ config: allFailed, configDir: dir, outDir, log: () => {} });
  assert.equal(empty.failures.length, 1);
  assert.deepEqual(empty.written, []);
  assert.equal(read(path.join(outDir, 'bundle.json')), bundleAfterPartial);
  assert.equal(read(path.join(outDir, 'baked.mjs')), moduleAfterPartial);
  assert.deepEqual(tempFiles(outDir), []);
});
test('files emitter rejects a non-JSON-safe structured record without writing it', async (t) => {
  const outDir = makeTmpDir(t, 'publish-files-invalid');
  const records = [{ job: 'level', type: 'level-graph', bucket: 'levels', key: 'arena', value: { rows: 2, broken: undefined } }];
  await assert.rejects(
    () => runEmittersFor(records, { emitters: [{ type: 'files' }] }, outDir),
    /files emitter \(levels\.arena\): \$\.broken is undefined/,
  );
  assert.ok(!fs.existsSync(path.join(outDir, 'levels', 'arena.json')));
  assert.ok(!fs.existsSync(path.join(outDir, 'index.json')));
});

test('files emitter merge:true keeps index entries from earlier runs', async (t) => {
  const outDir = makeTmpDir(t, 'publish-files-merge');
  const config = { emitters: [{ type: 'files', merge: true }] };
  await runEmittersFor([imageRecord()], config, outDir, { provenance: { tile: {} } });
  await runEmittersFor([skyRecord], config, outDir, { provenance: { sky: {} } });

  const index = JSON.parse(read(path.join(outDir, 'index.json')));
  assert.deepEqual(index.files.map((entry) => entry.file).sort(), ['sky/nebula.png', 'textures/rock.png']);
  assert.deepEqual(Object.keys(index.provenance).sort(), ['sky', 'tile']);
});

test('esm emitter merge:true preserves the previous module exports', async (t) => {
  const outDir = makeTmpDir(t, 'publish-esm-merge');
  const config = { emitters: [{ type: 'esm', file: 'baked.mjs', export: 'BAKED', merge: true }] };
  await runEmittersFor([imageRecord(), skyRecord], config, outDir, { provenance: { tile: {}, sky: {} } });
  await runEmittersFor([imageRecord({ value: { v: 2 } })], config, outDir, { provenance: { tile: {} } });

  const module = await import(`${pathToFileURL(path.join(outDir, 'baked.mjs')).href}?t=${Date.now()}`);
  assert.deepEqual(module.BAKED.textures.rock, { v: 2 });
  assert.ok(module.BAKED.sky.nebula);
  assert.deepEqual(module.default, module.BAKED);
});

test('esm emitter merge:true also merges a flat record list', async (t) => {
  const outDir = makeTmpDir(t, 'publish-esm-records');
  const config = { emitters: [{ type: 'esm', file: 'records.mjs', export: 'RECORDS', shape: 'records', merge: true }] };
  await runEmittersFor([imageRecord()], config, outDir, { provenance: { tile: {} } });
  await runEmittersFor([skyRecord], config, outDir, { provenance: { sky: {} } });

  const module = await import(`${pathToFileURL(path.join(outDir, 'records.mjs')).href}?t=${Date.now()}`);
  assert.deepEqual(module.RECORDS.map((record) => `${record.bucket}/${record.key}`).sort(), ['sky/nebula', 'textures/rock']);
});

test('audio-pack merge:true keeps earlier manifest entries', async (t) => {
  const outDir = makeTmpDir(t, 'publish-audio-pack');
  const config = { emitters: [{ type: 'audio-pack', dir: 'pack', merge: true }] };
  const space = (key, job) => ({ job, type: 'echo-map', bucket: 'spaces', key, value: { lattice: 'square', taps: [] } });
  await runEmittersFor([space('arena', 'a')], config, outDir, { provenance: { a: {} } });
  await runEmittersFor([space('hall', 'b')], config, outDir, { provenance: { b: {} } });

  const manifest = JSON.parse(read(path.join(outDir, 'pack', 'manifest.json')));
  assert.deepEqual(Object.keys(manifest.spaces).sort(), ['spaces/arena', 'spaces/hall']);
  assert.deepEqual(Object.keys(manifest.provenance).sort(), ['a', 'b']);
  assert.ok(fs.existsSync(path.join(outDir, 'pack', 'spaces', 'arena.json')));
});

const responseLike = ({ ok = true, status = 200, contentType, body = Buffer.from('data') } = {}) => ({
  ok,
  status,
  headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType ?? null : null) },
  arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
});

const stubApi = (response) => createApi({ baseUrl: 'http://stub.invalid', fetchImpl: async () => response });

test('downloadOutput validates status, declared content type and empty bodies', async () => {
  assert.equal(normalizeContentType('Application/JSON; charset=utf-8'), 'application/json');
  assert.equal(normalizeContentType(undefined), '');

  const buffer = await stubApi(responseLike({ contentType: 'image/png' })).downloadOutput('http://stub.invalid/f', { contentType: 'image/png' });
  assert.equal(buffer.toString(), 'data');
  // Parameters on the served content type are ignored when comparing.
  await stubApi(responseLike({ contentType: 'application/json; charset=utf-8' })).downloadOutput('http://stub.invalid/f', { contentType: 'application/json' });
  // No declared type behaves exactly as before.
  const legacy = await stubApi(responseLike({ contentType: 'application/octet-stream' })).downloadOutput('http://stub.invalid/f');
  assert.equal(legacy.toString(), 'data');

  await assert.rejects(
    () => stubApi(responseLike({ contentType: 'text/plain' })).downloadOutput('http://stub.invalid/f', { contentType: 'image/png' }),
    /content-type "text\/plain" does not match the declared "image\/png"/,
  );
  await assert.rejects(
    () => stubApi(responseLike({ contentType: 'image/png', body: Buffer.alloc(0) })).downloadOutput('http://stub.invalid/f', { contentType: 'image/png' }),
    /empty body/,
  );
  await assert.rejects(() => stubApi(responseLike({ ok: false, status: 404 })).downloadOutput('http://stub.invalid/f'), /-> 404/);
});

test('partial runs through the CLI keep previously published records (examples/publish.json)', async (t) => {
  const outDir = path.join(makeTmpDir(t, 'publish-cli'), 'out');
  const config = path.join(ROOT, 'examples', 'publish.json');

  const full = await runCli(['run', '--config', config, '--out', outDir]);
  assert.equal(full.code, 0, full.stderr);
  let bundle = JSON.parse(read(path.join(outDir, 'bundle.json')));
  assert.ok(bundle.textures.rock);
  assert.ok(bundle.sky.nebula);

  const partial = await runCli(['run', '--config', config, '--out', outDir, '--only', 'nebula-sky']);
  assert.equal(partial.code, 0, partial.stderr);
  bundle = JSON.parse(read(path.join(outDir, 'bundle.json')));
  assert.ok(bundle.textures.rock, 'a partial run keeps the previously published texture');
  assert.ok(bundle.sky.nebula);
  const module = await import(`${pathToFileURL(path.join(outDir, 'baked.mjs')).href}?t=${Date.now()}`);
  assert.ok(module.BAKED.textures.rock);

  // A dry run writes nothing at all, even with merge emitters configured.
  const bundleBefore = read(path.join(outDir, 'bundle.json'));
  const moduleBefore = read(path.join(outDir, 'baked.mjs'));
  const filesBefore = listFiles(outDir);
  const dry = await runCli(['run', '--config', config, '--out', outDir, '--dry']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /nothing written/);
  assert.equal(read(path.join(outDir, 'bundle.json')), bundleBefore);
  assert.equal(read(path.join(outDir, 'baked.mjs')), moduleBefore);
  assert.deepEqual(listFiles(outDir), filesBefore);
});
