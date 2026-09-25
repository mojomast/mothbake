import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createCandidateStore, validateCandidate, validateCandidatePath } from '../src/candidates.mjs';
import { readFixture } from './helpers.mjs';

const png = readFixture('tile.png');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mothbake-candidates-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createCandidateStore({ workspaceRoot: root });
  await fs.mkdir(path.join(root, 'assets'));
  await fs.writeFile(path.join(root, 'assets', 'a.png'), png);
  const candidate = {
    version: 1, id: 'image-1', kind: 'image',
    source: { path: 'assets/a.png', sha256: hash(png) },
    result: { path: 'assets/a.png', sha256: hash(png) },
    params: { prompt: 'test' }, parameterDelta: { strength: 0.2 }, backend: 'fixture',
    provenance: { run: 'local' }, qualityReport: { score: 1 },
    favorite: false, rejected: false, notes: '',
  };
  return { root, store, candidate };
}

test('empty index, versioned records, verified assets and atomic metadata persistence', async (t) => {
  const { root, store, candidate } = await fixture(t);
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.get('missing'), null);
  assert.deepEqual(await store.addCandidate(candidate), candidate);
  assert.deepEqual(await store.list(), [candidate]);
  assert.deepEqual(await store.readAsset(candidate.id, 'result'), png);
  assert.deepEqual(await store.mutateMetadata(candidate.id, { favorite: true, notes: 'keep' }),
    { ...candidate, favorite: true, notes: 'keep' });
  const reopened = createCandidateStore({ workspaceRoot: root });
  assert.equal((await reopened.get(candidate.id)).notes, 'keep');
  assert.equal((await reopened.get(candidate.id)).favorite, true);
  assert.equal((await reopened.mutateMetadata(candidate.id, { rejected: true })).rejected, true);
  assert.deepEqual((await fs.readdir(path.join(root, 'candidates'))), ['image-1.json']);
  await assert.rejects(store.addCandidate(candidate), /EEXIST/);
});

test('IDs, traversal, absolute paths, unsupported media and malformed records fail closed', async (t) => {
  const { root, store, candidate } = await fixture(t);
  for (const id of ['../secret', '..', '/etc/passwd', 'a/b', '.hidden', 'a.json', '']) {
    await assert.rejects(store.get(id), /invalid candidate id/);
    await assert.rejects(store.readAsset(id, 'source'), /invalid candidate id/);
  }
  for (const name of ['../outside.png', 'assets/../outside.png', '/etc/passwd', 'C:/outside.png', 'assets\\a.png', 'assets//a.png']) {
    assert.throws(() => validateCandidatePath(name), /invalid candidate asset path/);
    assert.throws(() => validateCandidate({ ...candidate, result: { ...candidate.result, path: name } }), /invalid candidate asset path/);
  }
  assert.throws(() => validateCandidate({ ...candidate, result: { path: 'assets/a.svg', sha256: hash(png) } }), /unsupported/);
  assert.throws(() => validateCandidate({ ...candidate, result: { ...candidate.result, sha256: 'bad' } }), /hash/);
  assert.throws(() => validateCandidate({ ...candidate, version: 2 }), /version/);
  await store.addCandidate(candidate);
  await fs.writeFile(path.join(root, 'candidates', 'bad.json'), '{bad json');
  await fs.writeFile(path.join(root, 'candidates', 'mismatch.json'), JSON.stringify(candidate));
  assert.deepEqual(await store.list(), [candidate]);
  await assert.rejects(store.get('bad'), /corrupt candidate/);
  await assert.rejects(store.get('mismatch'), /id does not match/);
  assert.throws(() => store.mutateMetadata('image-1', { notes: 42 }), /invalid candidate metadata/);
  assert.equal((await store.get('image-1')).notes, '');
});

test('symlink escapes and hash mismatches are rejected before returning asset bytes', async (t) => {
  const { root, store, candidate } = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mothbake-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'secret.png'), png);
  await fs.symlink(outside, path.join(root, 'linked'));
  await store.addCandidate({ ...candidate, result: { path: 'linked/secret.png', sha256: hash(png) } });
  await assert.rejects(store.readAsset('image-1', 'result'), /escapes workspace/);
  assert.deepEqual(await store.readAsset('image-1', 'source'), png);
  await fs.writeFile(path.join(root, 'assets', 'a.png'), Buffer.from('changed'));
  await assert.rejects(store.readAsset('image-1', 'source'), /hash or media format mismatch/);
});

test('candidate directory symlinks, record symlinks and oversized JSON cannot be indexed', async (t) => {
  const { root, store, candidate } = await fixture(t);
  await fs.mkdir(path.join(root, 'candidates'));
  await fs.symlink(path.join(root, 'assets', 'a.png'), path.join(root, 'candidates', 'image-1.json'));
  await assert.rejects(store.get('image-1'), /corrupt candidate/);
  assert.deepEqual(await store.list(), []);
  await assert.rejects(store.addCandidate(candidate), /EEXIST/);
  await fs.unlink(path.join(root, 'candidates', 'image-1.json'));
  await fs.writeFile(path.join(root, 'candidates', 'image-1.json'), 'x'.repeat(1024 * 1024 + 1));
  await assert.rejects(store.get('image-1'), /size limit/);
  await fs.rm(path.join(root, 'candidates'), { recursive: true });
  await fs.symlink(path.join(root, 'assets'), path.join(root, 'candidates'));
  await assert.rejects(store.list(), /unsafe candidates directory/);
});

test('valid hashes alone cannot turn unsupported bytes into media; material JSON is bounded', async (t) => {
  const { root, store, candidate } = await fixture(t);
  const spoof = Buffer.from('private bytes');
  await fs.writeFile(path.join(root, 'assets', 'spoof.png'), spoof);
  await store.addCandidate({ ...candidate, result: { path: 'assets/spoof.png', sha256: hash(spoof) } });
  await assert.rejects(store.readAsset(candidate.id, 'result'), /media format mismatch/);

  const json = Buffer.from('{"material":"wood"}');
  await fs.writeFile(path.join(root, 'assets', 'wood.json'), json);
  const material = {
    ...candidate, id: 'wood', kind: 'material',
    source: { path: 'assets/wood.json', sha256: hash(json) },
    result: { path: 'assets/wood.json', sha256: hash(json) },
  };
  await store.addCandidate(material);
  assert.deepEqual(await store.readAsset('wood', 'result'), json);
  const huge = Buffer.from(JSON.stringify({ value: 'a'.repeat(1024 * 1024) }));
  await fs.writeFile(path.join(root, 'assets', 'wood.json'), huge);
  await assert.rejects(store.readAsset('wood', 'result'), /size limit/);
});

test('signature-only PNG and truncated WAV are not verified media', async (t) => {
  const { root, store, candidate } = await fixture(t);
  const fakePng = Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex');
  await fs.writeFile(path.join(root, 'assets', 'a.png'), fakePng);
  await store.addCandidate({ ...candidate, source: { ...candidate.source, sha256: hash(fakePng) }, result: { ...candidate.result, sha256: hash(fakePng) } });
  await assert.rejects(store.readAsset(candidate.id, 'source'), /media format mismatch/);

  const fakeWav = Buffer.from('RIFF\x24\x00\x00\x00WAVE');
  await fs.writeFile(path.join(root, 'assets', 'a.wav'), fakeWav);
  await store.addCandidate({ ...candidate, id: 'sound', kind: 'audio', source: { path: 'assets/a.wav', sha256: hash(fakeWav) }, result: { path: 'assets/a.wav', sha256: hash(fakeWav) } });
  await assert.rejects(store.readAsset('sound', 'result'), /media format mismatch/);
  const validWav = readFixture('clip-pcm16.wav');
  await fs.writeFile(path.join(root, 'assets', 'a.wav'), validWav);
  await store.addCandidate({
    ...candidate, id: 'valid-sound', kind: 'audio', source: { path: 'assets/a.wav', sha256: hash(validWav) },
    result: { path: 'assets/a.wav', sha256: hash(validWav) },
  });
  assert.deepEqual(await store.readAsset('valid-sound', 'result'), validWav);
});

test('candidate assets require JPEG segments and complete MP3 frames even with matching hashes', async (t) => {
  const { root, store, candidate } = await fixture(t);
  const jpeg = Buffer.from('ffd8ffc0000b080001000101011100ffda0008010100003f001234ffd9', 'hex');
  const image = { ...candidate, id: 'jpeg', source: { path: 'assets/a.jpg', sha256: hash(jpeg) }, result: { path: 'assets/a.jpg', sha256: hash(jpeg) } };
  await fs.writeFile(path.join(root, 'assets', 'a.jpg'), jpeg);
  await store.addCandidate(image);
  assert.deepEqual(await store.readAsset('jpeg', 'result'), jpeg);
  const bad = Buffer.from(jpeg);
  bad[4] = 0xff;
  await fs.writeFile(path.join(root, 'assets', 'bad.jpg'), bad);
  await store.addCandidate({ ...image, id: 'bad-jpeg', result: { path: 'assets/bad.jpg', sha256: hash(bad) } });
  await assert.rejects(store.readAsset('bad-jpeg', 'result'), /media format mismatch/);

  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0]);
  await fs.writeFile(path.join(root, 'assets', 'sound.mp3'), frame);
  const audio = { ...candidate, id: 'mp3', kind: 'audio', source: { path: 'assets/sound.mp3', sha256: hash(frame) }, result: { path: 'assets/sound.mp3', sha256: hash(frame) } };
  await store.addCandidate(audio);
  assert.deepEqual(await store.readAsset('mp3', 'source'), frame);
  const truncated = frame.subarray(0, -1);
  await fs.writeFile(path.join(root, 'assets', 'short.mp3'), truncated);
  await store.addCandidate({ ...audio, id: 'short-mp3', result: { path: 'assets/short.mp3', sha256: hash(truncated) } });
  await assert.rejects(store.readAsset('short-mp3', 'result'), /media format mismatch/);
});
