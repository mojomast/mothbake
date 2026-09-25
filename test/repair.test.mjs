// Offline repair: rebuild every built-in baker from the raw outputs a normal run
// archived under <out>/raw/<raw>/, with no API key and no credits. Every input
// is a committed fixture or a JSON value synthesized in the test.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { decodeWav } from '../src/decoders/index.mjs';
import { LOCAL_BAKE_TYPES, isLocalBake, readRawResults, rebuildLocalBakes, repairConfig } from '../src/repair.mjs';
import { runConfig } from '../src/runner.mjs';
import { openRunJournal, readRunJournal } from '../src/run-journal.mjs';
import { fixture, makeTmpDir, readFixture, ROOT, runCli, writeJson } from './helpers.mjs';

const EXAMPLES = path.join(ROOT, 'examples', 'manifest.json');

/** A small config whose jobs are all rebuildable from local raw files. */
function localConfig() {
  return {
    version: 1,
    generator: 'mothbake-test',
    emitters: [
      { type: 'files' },
      { type: 'audio-pack', dir: 'pack' },
      { type: 'esm', file: 'baked.mjs', export: 'BAKED' },
    ],
    jobs: [
      {
        id: 'cavern-ir',
        engine: 'retrocausal-echo-v1',
        credits: 2,
        raw: 'cavern-ir',
        bake: { type: 'ir', name: 'cavern', urlBase: '/audio/irs' },
        recorded: { outputs: { result: fixture('impulse.wav'), taps: fixture('impulse-taps.json') } },
      },
      {
        id: 'echo-arena',
        engine: 'otoc-echo-v1',
        credits: 1,
        raw: 'echo-arena',
        bake: { type: 'echo-map', name: 'arena', urlBase: '/audio/spaces', maxTaps: 8 },
        recorded: { result: fixture('echo-trajectory.json') },
      },
      {
        id: 'bed-clip',
        engine: 'qrc-audio-v1',
        raw: 'bed-clip',
        bake: { type: 'audio-clip', name: 'bed-ritual', embed: false, urlBase: '/moth/files', sampleFormat: 'pcm16' },
        recorded: { outputs: { result: fixture('clip-padded.wav') } },
      },
      {
        id: 'stitch-clip',
        engine: 'qrc-audio-v1',
        raw: 'stitch-clip',
        bake: { type: 'audio-stitch', name: 'bed-stitched', slots: [{ slot: 'a', gain: 0.8 }, 'b'], sampleFormat: 'pcm16' },
        recorded: { outputs: { a: fixture('clip-pcm16.wav'), b: fixture('clip-padded.wav') } },
      },
      // A non-local job: repair must leave it untouched.
      {
        id: 'rock-tile',
        engine: 'blur-v1',
        raw: 'rock-tile',
        bake: { type: 'texture-tile', name: 'rock', size: 8 },
        recorded: { outputs: { result: fixture('tile.png') } },
      },
    ],
  };
}

test('LOCAL_BAKE_TYPES covers every built-in baker with archived inputs', () => {
  for (const type of ['ir', 'ir-descriptor', 'echo-map', 'audio-clip', 'audio-stitch']) {
    assert.ok(LOCAL_BAKE_TYPES.has(type), `${type} should be locally rebuildable`);
  }
  assert.ok(isLocalBake({ bake: { type: 'audio-clip', embed: false } }));
  assert.equal(isLocalBake({ bake: { type: 'texture-tile' } }), true);
  assert.equal(isLocalBake({}), false);
});

test('readRawResults maps archived files back to slots and the inline result', (t) => {
  const dir = makeTmpDir(t, 'repair-read');
  fs.writeFileSync(path.join(dir, 'result.wav'), readFixture('clip-pcm16.wav'));
  fs.writeFileSync(path.join(dir, 'taps.json'), readFixture('impulse-taps.json'));
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ output: [[1]] }));
  fs.mkdirSync(path.join(dir, 'nested'));

  const { files, saved, result } = readRawResults(dir, 'raw-name', dir, { bake: { type: 'ir', tapsSlot: 'taps' } });
  assert.deepEqual([...files.keys()].sort(), ['result', 'taps']);
  assert.ok(Buffer.isBuffer(files.get('result')));
  assert.equal(saved.get('result').relative, 'result.wav');
  assert.equal(saved.get('taps').relative, 'taps.json');
  assert.deepEqual(result, { output: [[1]] });
});

test('repair rebuilds every local record from the archived raw outputs offline', async (t) => {
  const dir = makeTmpDir(t, 'repair-run');
  const config = localConfig();
  const outDir = path.join(dir, 'out');

  // A normal recorded run archives the raw outputs and emits everything.
  const first = await runConfig({ config, configDir: dir, outDir, log: () => {} });
  assert.deepEqual(first.failures, []);
  assert.equal(first.records.length, 5);

  // Delete the emitted artifacts but keep the raw archive, then repair.
  fs.rmSync(path.join(outDir, 'baked.mjs'));
  fs.rmSync(path.join(outDir, 'pack'), { recursive: true });
  fs.rmSync(path.join(outDir, 'audio'), { recursive: true });
  fs.rmSync(path.join(outDir, 'irs'), { recursive: true });
  fs.rmSync(path.join(outDir, 'spaces'), { recursive: true });

  const repaired = await repairConfig({ config, configDir: dir, outDir, log: () => {} });
  assert.deepEqual(repaired.failures, []);
  assert.deepEqual(repaired.buckets, { irs: 1, audio: 2, spaces: 1, textures: 1 });
  assert.equal(repaired.records.length, 5, 'every built-in baker is rebuilt from its archive');

  // The audio-clip record points at a separately processed file, never raw.
  const bed = repaired.records.find((record) => record.key === 'bed-ritual');
  assert.equal(bed.type, 'audio-clip');
  assert.equal(bed.value.data, undefined);
  assert.match(bed.value.file, /^processed\/audio\/[a-f0-9]{64}\.wav$/);
  assert.equal(bed.value.url, `/moth/files/bed-clip/${path.basename(bed.value.file)}`);
  assert.deepEqual(fs.readFileSync(path.join(outDir, 'pack', 'audio', 'bed-ritual.wav')), fs.readFileSync(path.join(outDir, bed.value.file)));
  assert.notDeepEqual(fs.readFileSync(path.join(outDir, bed.value.file)), readFixture('clip-padded.wav'));

  // The ir and echo-map records are rebuilt too.
  const cavern = repaired.records.find((record) => record.key === 'cavern');
  assert.equal(cavern.value.file, path.join('raw', 'cavern-ir', 'result.wav'));
  assert.ok(cavern.value.taps.length > 0);
  const arena = repaired.records.find((record) => record.key === 'arena');
  assert.equal(arena.value.count, 5);

  // The emitted bundle and pack came back, including the image baker.
  assert.ok(fs.existsSync(path.join(outDir, 'baked.mjs')));
  const baked = await import(`${pathToFileURL(path.join(outDir, 'baked.mjs')).href}?v=1`);
  assert.deepEqual(Object.keys(baked.BAKED.audio).sort(), ['bed-ritual', 'bed-stitched']);
  assert.ok(baked.BAKED.textures.rock);
  assert.equal(baked.BAKED.provenance['cavern-ir'].jobId, null);
});

test('repair rejects a changed raw result whose archive hash no longer matches', async (t) => {
  const dir = makeTmpDir(t, 'repair-changed');
  const config = localConfig();
  const outDir = path.join(dir, 'out');
  await runConfig({ config, configDir: dir, outDir, log: () => {} });

  const taps = {
    extras: {
      taps: [
        { site: 0, depth: 1, level: 0.9, polarity: 1, F_re: 0.1, F_im: 0 },
        { site: 1, depth: 2, level: 0.4, polarity: -1, F_re: 0.2, F_im: 0.3 },
      ],
    },
  };
  fs.writeFileSync(path.join(outDir, 'raw', 'cavern-ir', 'taps.json'), `${JSON.stringify(taps)}\n`);

  const repaired = await repairConfig({ config, configDir: dir, outDir, log: () => {} });
  assert.ok(repaired.failures.some((failure) => failure.id === 'cavern-ir' && /mismatch/.test(failure.message)));
  assert.equal(repaired.records.some((record) => record.key === 'cavern'), false);
});

test('repair is deterministic and idempotent', async (t) => {
  const dir = makeTmpDir(t, 'repair-deterministic');
  const config = localConfig();
  const outDir = path.join(dir, 'out');
  await runConfig({ config, configDir: dir, outDir, log: () => {} });

  await repairConfig({ config, configDir: dir, outDir, log: () => {} });
  const firstBundle = fs.readFileSync(path.join(outDir, 'baked.mjs'));
  const firstPack = fs.readFileSync(path.join(outDir, 'pack', 'manifest.json'));
  await repairConfig({ config, configDir: dir, outDir, log: () => {} });
  assert.deepEqual(fs.readFileSync(path.join(outDir, 'baked.mjs')), firstBundle);
  assert.deepEqual(fs.readFileSync(path.join(outDir, 'pack', 'manifest.json')), firstPack);
});

test('rebuildLocalBakes reports a missing raw archive instead of throwing', async (t) => {
  const dir = makeTmpDir(t, 'repair-missing');
  const config = localConfig();
  const outDir = path.join(dir, 'empty');
  fs.mkdirSync(outDir, { recursive: true });

  const result = rebuildLocalBakes({ config, configDir: dir, outDir, log: () => {} });
  assert.equal(result.records.length, 0);
  assert.equal(result.failures.length, 5);
  assert.ok(result.failures.every((failure) => /no raw outputs/.test(failure.message)));
});

test('repair rejects an unknown --only id through the CLI', async (t) => {
  const dir = makeTmpDir(t, 'repair-only-unknown');
  const file = writeJson(path.join(dir, 'mothbake.json'), localConfig());
  const { code, stderr } = await runCli(['repair', '--config', file, '--out', path.join(dir, 'out'), '--only', 'nope']);
  assert.equal(code, 1);
  assert.match(stderr, /--only did not match any job: nope/);
});

test('repair runs through the CLI with no API key and can be scoped with --only', async (t) => {
  const dir = makeTmpDir(t, 'repair-cli');
  const file = writeJson(path.join(dir, 'mothbake.json'), localConfig());
  const outDir = path.join(dir, 'out');
  await runConfig({ config: localConfig(), configDir: dir, outDir, log: () => {} });
  fs.rmSync(path.join(outDir, 'baked.mjs'));

  const all = await runCli(['repair', '--config', file, '--out', outDir]);
  assert.equal(all.code, 0, all.stderr);
  assert.match(all.stdout, /repaired 5 record\(s\)/);
  assert.equal(all.stderr.includes('reusing job'), false);

  fs.rmSync(path.join(outDir, 'pack'), { recursive: true });
  const one = await runCli(['repair', '--config', file, '--out', outDir, '--only', 'bed-clip']);
  assert.equal(one.code, 0, one.stderr);
  assert.match(one.stdout, /repaired 1 record\(s\)/);
  assert.ok(fs.existsSync(path.join(outDir, 'pack', 'audio', 'bed-ritual.wav')));

  const missing = await runCli(['repair', '--config', file, '--out', path.join(dir, 'empty')]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /no raw outputs/);
});

test('the example manifest repairs its local records offline', async (t) => {
  const dir = makeTmpDir(t, 'repair-examples');
  const outDir = path.join(dir, 'out');
  // Run the committed example, then repair only the local types from its raw.
  const loaded = JSON.parse(fs.readFileSync(EXAMPLES, 'utf8'));
  const first = await runConfig({ config: loaded, configDir: path.dirname(EXAMPLES), outDir, log: () => {} });
  assert.deepEqual(first.failures, []);

  const repaired = await repairConfig({ config: loaded, configDir: path.dirname(EXAMPLES), outDir, log: () => {} });
  assert.deepEqual(repaired.failures, []);
  assert.equal(repaired.records.length, 26);
  const bed = repaired.records.find((record) => record.key === 'bed-ritual');
  assert.match(bed.value.file, /^processed\/audio\/[a-f0-9]{64}\.wav$/);
  assert.equal(decodeWav(fs.readFileSync(path.join(outDir, 'pack', 'audio', 'bed-ritual.wav')), { mixdown: true }).frames, bed.value.frames);
});

test('one archived remote result feeds several local bakers without another submission', async (t) => {
  const outDir = path.join(makeTmpDir(t, 'repair-multi-bake'), 'out');
  const config = { jobs: [{
    id: 'field', engine: 'blur-core-v1', recorded: { result: { output: [[0, 1], [2, 3]] } },
    bakes: [
      { type: 'raw-grid', name: 'field-values' },
      { type: 'normal-map', name: 'field-normal', size: 4, strength: 1 },
    ],
  }] };
  const first = await runConfig({ config, outDir, log: () => {} });
  assert.deepEqual(first.failures, []);
  assert.deepEqual(first.records.map((record) => record.type), ['raw-grid', 'normal-map']);
  assert.equal(fs.readdirSync(path.join(outDir, 'raw', 'field')).filter((name) => name === '.mothbake-archive.json').length, 1);
  const repaired = await repairConfig({ config, outDir, log: () => {} });
  assert.deepEqual(repaired.failures, []);
  assert.deepEqual(repaired.records.map((record) => record.type), ['raw-grid', 'normal-map']);
});

test('repair holds the output journal lock through asynchronous publication', async (t) => {
  const outDir = path.join(makeTmpDir(t, 'repair-lock'), 'out');
  const config = { jobs: [{ id: 'field', engine: 'blur-core-v1', recorded: { result: { output: [[0, 1], [2, 3]] } }, bake: { type: 'raw-grid', name: 'field' } }] };
  await runConfig({ config, outDir });
  let entered;
  const publishing = new Promise((resolve) => { entered = resolve; });
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const repair = repairConfig({ config: { ...config, emitters: [async () => { entered(); await waiting; return []; }] }, outDir });
  await publishing;
  assert.throws(() => openRunJournal(outDir), /locked/);
  await assert.rejects(repairConfig({ config, outDir }), /locked/);
  release();
  await repair;
  const journal = openRunJournal(outDir);
  journal.close();
});

test('repair abort during an emitter records durable local failure and retains remote ID', async (t) => {
  const outDir = path.join(makeTmpDir(t, 'repair-abort'), 'out');
  const config = { jobs: [{ id: 'field', engine: 'blur-core-v1', recorded: { result: { output: [[0, 1], [2, 3]] } }, bake: { type: 'raw-grid', name: 'field' } }] };
  await runConfig({ config, outDir });
  const journal = openRunJournal(outDir);
  journal.transition('field', 'submitted', { jobId: 'remote-9' });
  journal.close();
  const controller = new AbortController();
  let secondStarted = false;
  await assert.rejects(repairConfig({ config: { ...config, emitters: [async () => {
    controller.abort();
    return [];
  }, () => { secondStarted = true; return []; }] }, outDir, signal: controller.signal }), /local repair aborted/);
  assert.equal(secondStarted, false);
  assert.equal(readRunJournal(outDir).jobs.field.state, 'local-failed');
  assert.equal(readRunJournal(outDir).jobs.field.jobId, 'remote-9');
  assert.ok(!fs.existsSync(path.join(outDir, 'run-journal.lock')));
});

test('repair abort between local bakes stops publication and persists local failure', async (t) => {
  const outDir = path.join(makeTmpDir(t, 'repair-local-abort'), 'out');
  const config = { jobs: [{ id: 'field', engine: 'blur-core-v1', recorded: { result: { output: [[0, 1], [2, 3]] } }, bakes: [
    { type: 'raw-grid', name: 'first' }, { type: 'raw-grid', name: 'second' },
  ] }] };
  await runConfig({ config, outDir });
  const controller = new AbortController();
  let emitted = false;
  await assert.rejects(repairConfig({
    config: { ...config, emitters: [() => { emitted = true; return []; }] }, outDir,
    signal: controller.signal,
    log(message) { if (message.includes('rebuilt ')) controller.abort(); },
  }), /local repair aborted/);
  assert.equal(emitted, false);
  assert.equal(readRunJournal(outDir).jobs.field.state, 'local-failed');
});

test('repair uses the same explicit stale-lock policy as run', async (t) => {
  const outDir = path.join(makeTmpDir(t, 'repair-stale-lock'), 'out');
  const config = { jobs: [] };
  const old = openRunJournal(outDir, { clock: () => 1_000, pid: 12345, hostname: 'test-host' });
  const journalOptions = { clock: () => 3_601_001, pid: 23456, hostname: 'test-host', isProcessAlive: () => false };
  await assert.rejects(repairConfig({ config, outDir, journalOptions }), /pass breakLock/);
  await repairConfig({ config, outDir, journalOptions, breakLock: true });
  assert.throws(() => old.close(), /no longer owned/);
});
