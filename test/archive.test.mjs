import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { archiveResponse, readArchive, ARCHIVE_MANIFEST } from '../src/archive.mjs';
import { dependencyArtifactFingerprint, generationInstanceFingerprint, hashBytes, recordedFixtureFingerprint } from '../src/identity.mjs';
import { makeTmpDir, readFixture } from './helpers.mjs';

test('archives recorded files and inline results with durable hashes', async (t) => {
  const outDir = makeTmpDir(t, 'archive');
  const response = { files: new Map([['image', readFixture('tile.png')]]), sources: new Map([['image', 'tile.png']]), result: { count: 3 } };
  const saved = await archiveResponse({ response, outDir, rawName: 'demo', recipeFingerprint: 'r', generationFingerprint: 'g', engine: 'e' });
  assert.equal(saved.verified, true);
  assert.ok(fs.existsSync(path.join(outDir, 'raw', 'demo', ARCHIVE_MANIFEST)));
  const loaded = readArchive({ outDir, rawName: 'demo' });
  assert.deepEqual(loaded.files.get('image'), readFixture('tile.png'));
  assert.deepEqual(loaded.result, { count: 3 });
  assert.equal(loaded.rawFingerprint, saved.rawFingerprint);
  const text = fs.readFileSync(path.join(outDir, 'raw', 'demo', ARCHIVE_MANIFEST), 'utf8');
  assert.ok(!text.includes('http'), 'signed URLs are not archived');
});

test('detects missing, changed and escaping archive blobs', async (t) => {
  const outDir = makeTmpDir(t, 'archive-corrupt');
  await archiveResponse({ response: { files: new Map([['result', readFixture('tile.png')]]), sources: new Map([['result', 'tile.png']]) }, outDir, rawName: 'demo', recipeFingerprint: 'r', generationFingerprint: 'g', engine: 'e' });
  const file = path.join(outDir, 'raw', 'demo', 'result.png');
  fs.appendFileSync(file, 'x');
  assert.throws(() => readArchive({ outDir, rawName: 'demo' }), /byte length mismatch/);
  fs.rmSync(file);
  assert.throws(() => readArchive({ outDir, rawName: 'demo' }), /missing/);

  const manifestFile = path.join(outDir, 'raw', 'demo', ARCHIVE_MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.outputs[0].file = '../escape.png';
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.throws(() => readArchive({ outDir, rawName: 'demo' }), /escapes/);
});

test('legacy archives remain readable but are not verified', (t) => {
  const outDir = makeTmpDir(t, 'archive-legacy');
  const rawDir = path.join(outDir, 'raw', 'legacy');
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(path.join(rawDir, 'result.wav'), readFixture('clip-pcm16.wav'));
  const legacy = readArchive({ outDir, rawName: 'legacy', job: { bake: { type: 'audio-clip' } } });
  assert.equal(legacy.verified, false);
  assert.ok(legacy.files.has('result'));
  assert.throws(() => readArchive({ outDir, rawName: 'legacy', requireVerified: true }), /legacy archive/);
});

test('identical generations reuse every archived byte without rewriting; conflicting evidence is rejected', async (t) => {
  const outDir = makeTmpDir(t, 'archive-reuse');
  const options = { outDir, rawName: 'demo', recipeFingerprint: 'r', generationFingerprint: 'g', engine: 'e', verification: 'recorded-fixture' };
  const response = { files: new Map([['image', Buffer.from('original')]]), sources: new Map([['image', 'tile.png']]), result: { count: 1 } };
  await archiveResponse({ ...options, response });
  const rawDir = path.join(outDir, 'raw', 'demo');
  const manifestFile = path.join(rawDir, ARCHIVE_MANIFEST);
  const before = fs.statSync(manifestFile).mtimeMs;
  const reused = await archiveResponse({ ...options, response });
  assert.equal(reused.rawFingerprint, readArchive({ outDir, rawName: 'demo' }).rawFingerprint);
  assert.equal(fs.statSync(manifestFile).mtimeMs, before);
  await assert.rejects(archiveResponse({ ...options, response: { ...response, files: new Map([['image', Buffer.from('changed')]]) } }), /different archive evidence/);
  assert.deepEqual(fs.readFileSync(path.join(rawDir, 'image.png')), Buffer.from('original'));
  await assert.rejects(archiveResponse({ ...options, engine: 'another', response }), /different archive evidence/);
  fs.writeFileSync(path.join(rawDir, 'image.png'), Buffer.from('tampered'));
  await assert.rejects(archiveResponse({ ...options, response }), /mismatch/);
});

test('colliding and reserved sanitized filenames fail before downloads or writes', async (t) => {
  const outDir = makeTmpDir(t, 'archive-collision');
  const options = { outDir, rawName: 'demo', recipeFingerprint: 'r', generationFingerprint: 'g', engine: 'e' };
  let downloads = 0;
  const api = { downloadOutput: async () => { downloads++; return Buffer.from('output'); } };
  for (const slots of [['A B', 'a-b'], ['inline-result', 'other']]) {
    const outputs = slots.map((slot, index) => ({ slot, url: `https://example.invalid/${index}.json`, content_type: 'application/json' }));
    if (slots[0] === 'inline-result') outputs.pop();
    await assert.rejects(archiveResponse({ ...options, api, response: { outputs } }), /collision/);
  }
  assert.equal(downloads, 0);
  assert.equal(fs.existsSync(path.join(outDir, 'raw', 'demo')), false);
});

test('failed download leaves no partial archive; legacy evidence is never overwritten', async (t) => {
  const outDir = makeTmpDir(t, 'archive-stage');
  const options = { outDir, rawName: 'demo', recipeFingerprint: 'r', generationFingerprint: 'g', engine: 'e' };
  const response = { outputs: [{ slot: 'first', url: 'https://example.invalid/1.png' }, { slot: 'second', url: 'https://example.invalid/2.png' }] };
  let attempts = 0;
  await assert.rejects(archiveResponse({ ...options, response, api: { downloadOutput: async () => {
    if (++attempts === 2) throw new Error('network failed');
    return Buffer.from('first');
  } } }), /network failed/);
  const rawDir = path.join(outDir, 'raw', 'demo');
  assert.equal(fs.existsSync(rawDir), false);
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(path.join(rawDir, 'old.bin'), 'legacy');
  await assert.rejects(archiveResponse({ ...options, response: { files: new Map() } }), /without a verified manifest/);
  assert.equal(fs.readFileSync(path.join(rawDir, 'old.bin'), 'utf8'), 'legacy');
});

test('recorded generation identity changes with fixture bytes and inline result', () => {
  const fixture = (bytes, result) => recordedFixtureFingerprint({ outputs: { image: hashBytes(Buffer.from(bytes)) }, result });
  const generation = (identity) => generationInstanceFingerprint({ recipe: 'recipe', jobId: 'recorded:demo', fixture: identity });
  assert.equal(generation(fixture('a', { seed: 1 })), generation(fixture('a', { seed: 1 })));
  assert.notEqual(generation(fixture('a', { seed: 1 })), generation(fixture('b', { seed: 1 })));
  assert.notEqual(generation(fixture('a', { seed: 1 })), generation(fixture('a', { seed: 2 })));
});

test('dependency identity binds the source slot and verified artifact bytes', () => {
  const base = { job: 'source', slot: 'image', raw: 'raw-1', sha256: 'bytes-1' };
  const fingerprint = dependencyArtifactFingerprint(base);
  assert.equal(fingerprint, dependencyArtifactFingerprint({ sha256: 'bytes-1', raw: 'raw-1', slot: 'image', job: 'source' }));
  for (const field of Object.keys(base)) assert.notEqual(fingerprint, dependencyArtifactFingerprint({ ...base, [field]: 'other' }));
});
