import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runEmitters } from '../src/emitters/index.mjs';
import { resolveCurrentPack } from '../src/transactional-pack.mjs';
import { makeTmpDir, readFixture } from './helpers.mjs';

const record = {
  job: 'clip', type: 'audio-clip', bucket: 'audio', key: 'hit',
  value: { container: 'wav', data: readFixture('clip-pcm16.wav').toString('base64'), seconds: 0.05, sampleRate: 8000, channels: 1 },
};

test('versioned audio pack publishes complete content and is idempotent', async (t) => {
  const outDir = makeTmpDir(t, 'audio-versioned');
  const config = { emitters: [{ type: 'audio-pack-versioned', dir: 'delivery' }] };
  await runEmitters({ config, records: [record], outDir, provenance: { clip: { engine: 'fixture' } } });
  const first = resolveCurrentPack(path.join(outDir, 'delivery'));
  assert.ok(fs.existsSync(path.join(first.directory, 'audio', 'hit.wav')));
  assert.ok(fs.existsSync(path.join(first.directory, 'manifest.json')));
  await runEmitters({ config, records: [record], outDir, provenance: { clip: { engine: 'fixture' } } });
  const second = resolveCurrentPack(path.join(outDir, 'delivery'));
  assert.equal(second.pointer.currentVersion, first.pointer.currentVersion);
  assert.deepEqual(fs.readFileSync(path.join(second.directory, 'audio', 'hit.wav')), readFixture('clip-pcm16.wav'));
  assert.deepEqual(fs.readdirSync(path.join(outDir, 'delivery', '.versions')), [first.pointer.currentVersion]);
});

test('versioned partial audio cannot replace a complete published pack', async (t) => {
  const outDir = makeTmpDir(t, 'audio-versioned-partial');
  const other = { ...record, job: 'other', key: 'other' };
  const config = { emitters: [{ type: 'audio-pack-versioned', dir: 'delivery' }] };
  const run = (records, emitters = config.emitters) => runEmitters({ config: { emitters }, records, outDir, provenance: { clip: {}, other: {} } });
  await run([record, other]);
  const root = path.join(outDir, 'delivery');
  const pointer = fs.readFileSync(path.join(root, 'current.json'));
  await assert.rejects(() => run([record]), /incomplete: missing clips.audio\/other/);
  await assert.rejects(() => run([record], [{ type: 'audio-pack-versioned', dir: 'delivery', merge: true }]), /partial merge/);
  assert.deepEqual(fs.readFileSync(path.join(root, 'current.json')), pointer);
  assert.equal(fs.readdirSync(path.join(root, '.versions')).length, 1);
});

test('versioned audio refuses partial first publication when config declares missing audio jobs', async (t) => {
  const outDir = makeTmpDir(t, 'audio-versioned-first-partial');
  const config = { jobs: [
    { id: 'clip', bake: { type: 'audio-clip' } },
    { id: 'missing', bake: { type: 'audio-clip' } },
  ], emitter: { type: 'audio-pack-versioned', dir: 'delivery' } };
  await assert.rejects(() => runEmitters({ config, records: [record], outDir }), /incomplete: missing audio job missing/);
  assert.ok(!fs.existsSync(path.join(outDir, 'delivery', 'current.json')));
});

test('versioned audio validates destinations and accepts external processed files', async (t) => {
  const outDir = makeTmpDir(t, 'audio-versioned-external');
  const outside = makeTmpDir(t, 'audio-versioned-outside');
  fs.symlinkSync(outside, path.join(outDir, 'linked'));
  const run = (dir, records = [record]) => runEmitters({ config: { emitter: { type: 'audio-pack-versioned', dir } }, records, outDir });
  await assert.rejects(() => run('linked'), /symlink destination/);
  await assert.rejects(() => run('../outside'), /invalid destination/);
  fs.mkdirSync(path.join(outDir, 'processed'));
  fs.writeFileSync(path.join(outDir, 'processed', 'hit.wav'), readFixture('clip-pcm16.wav'));
  await run('delivery', [{ ...record, value: { file: 'processed/hit.wav' } }]);
  const current = resolveCurrentPack(path.join(outDir, 'delivery'));
  assert.deepEqual(fs.readFileSync(path.join(current.directory, 'audio', 'hit.wav')), readFixture('clip-pcm16.wav'));
  assert.deepEqual(fs.readdirSync(outside), []);
});
