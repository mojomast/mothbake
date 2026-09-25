import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { publishPackVersion, resolveCurrentPack, rollbackPack, inspectPointerShape } from '../src/transactional-pack.mjs';
import { makeTmpDir } from './helpers.mjs';

const build = (text) => async (dir) => {
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'value.txt'), text);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ file: 'assets/value.txt' }));
};
const validate = async (dir) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json')));
  if (!fs.existsSync(path.join(dir, manifest.file))) throw new Error('manifest file missing');
};

test('inspectPointerShape diagnoses without creating or changing pack state', async (t) => {
  const parent = makeTmpDir(t, 'pack-inspect');
  const missing = path.join(parent, 'missing');
  assert.deepEqual(inspectPointerShape(missing), { issues: ['pack root is missing'], hasContentHashes: false, current: null, previous: null });
  assert.equal(fs.existsSync(missing), false);
  const root = path.join(parent, 'root');
  fs.mkdirSync(root);
  assert.ok(inspectPointerShape(root).issues.includes('pointer is missing'));
  fs.writeFileSync(path.join(root, 'current.json'), JSON.stringify({ version: 1, currentVersion: 'old', previousVersion: null }));
  const before = fs.statSync(path.join(root, 'current.json'));
  const v1 = inspectPointerShape(root);
  assert.equal(v1.current, 'old');
  assert.equal(v1.hasContentHashes, false);
  assert.ok(v1.issues.some((issue) => issue.includes('v1-shaped')));
  assert.deepEqual(fs.readFileSync(path.join(root, 'current.json')), Buffer.from(JSON.stringify({ version: 1, currentVersion: 'old', previousVersion: null })));
  assert.equal(fs.statSync(path.join(root, 'current.json')).ino, before.ino);
});

test('publishes complete immutable versions and rolls back through an atomic pointer', async (t) => {
  const root = makeTmpDir(t, 'pack-transaction');
  await publishPackVersion({ root, versionId: 'v1', build: build('one'), validate });
  assert.equal(fs.readFileSync(path.join(resolveCurrentPack(root).directory, 'assets/value.txt'), 'utf8'), 'one');
  await publishPackVersion({ root, versionId: 'v2', build: build('two'), validate });
  assert.equal(resolveCurrentPack(root).pointer.previousVersion, 'v1');
  assert.equal(fs.readFileSync(path.join(resolveCurrentPack(root).directory, 'assets/value.txt'), 'utf8'), 'two');
  const pointer = rollbackPack(root);
  assert.equal(pointer.currentVersion, 'v1');
  assert.equal(pointer.previousVersion, 'v2');
  assert.equal(fs.readFileSync(path.join(resolveCurrentPack(root).directory, 'assets/value.txt'), 'utf8'), 'one');
});

test('build, validation and pre-promotion failures preserve the prior pack', async (t) => {
  const root = makeTmpDir(t, 'pack-failure');
  await publishPackVersion({ root, versionId: 'good', build: build('good'), validate });
  const before = fs.readFileSync(path.join(root, 'current.json'));
  await assert.rejects(() => publishPackVersion({ root, versionId: 'build-fail', build: async (dir) => { fs.writeFileSync(path.join(dir, 'partial'), 'x'); throw new Error('interrupted'); }, validate }), /interrupted/);
  await assert.rejects(() => publishPackVersion({ root, versionId: 'validation-fail', build: build('bad'), validate: async () => { throw new Error('invalid pack'); } }), /invalid pack/);
  await assert.rejects(() => publishPackVersion({ root, versionId: 'pointer-fail', build: build('complete'), validate, failpoint: (point) => { if (point === 'before-pointer') throw new Error('stop'); } }), /stop/);
  await assert.rejects(() => publishPackVersion({ root, versionId: 'post-pointer-fail', build: build('complete'), validate, failpoint: (point) => { if (point === 'after-pointer') throw new Error('stop after pointer'); } }), /stop after pointer/);
  assert.deepEqual(fs.readFileSync(path.join(root, 'current.json')), before);
  assert.equal(resolveCurrentPack(root).pointer.currentVersion, 'good');
  assert.deepEqual(fs.readdirSync(path.join(root, '.staging')), []);
  assert.deepEqual(fs.readdirSync(path.join(root, '.versions')), ['good']);
});

test('rejects symlinks and unsafe version identifiers', async (t) => {
  const root = makeTmpDir(t, 'pack-security');
  await assert.rejects(() => publishPackVersion({ root, versionId: '../escape', build: build('x'), validate }), /invalid pack version/);
  await assert.rejects(() => publishPackVersion({ root, versionId: 'linked', build: async (dir) => { fs.symlinkSync('/etc/passwd', path.join(dir, 'secret')); }, validate }), /symlink/);
  assert.equal(resolveCurrentPack(root), null);
});

test('administration, pointer, and existing versions cannot be symlinks', async (t) => {
  const root = makeTmpDir(t, 'pack-admin');
  const outside = makeTmpDir(t, 'pack-outside');
  fs.symlinkSync(outside, path.join(root, '.versions'));
  await assert.rejects(() => publishPackVersion({ root, versionId: 'v1', build: build('x'), validate }), /unsafe pack administration/);
  fs.unlinkSync(path.join(root, '.versions'));
  fs.symlinkSync(outside, path.join(root, '.staging'));
  await assert.rejects(() => publishPackVersion({ root, versionId: 'v1', build: build('x'), validate }), /unsafe pack administration/);
  fs.unlinkSync(path.join(root, '.staging'));
  await publishPackVersion({ root, versionId: 'v1', build: build('one'), validate });
  const before = fs.readFileSync(path.join(root, 'current.json'));
  fs.symlinkSync(outside, path.join(root, '.versions', 'dangling'));
  await assert.rejects(() => publishPackVersion({ root, versionId: 'dangling', reuseExisting: true, build: build('x'), validate }), /unsafe pack version/);
  assert.deepEqual(fs.readFileSync(path.join(root, 'current.json')), before);
  fs.renameSync(path.join(root, 'current.json'), path.join(root, 'saved.json'));
  fs.symlinkSync(path.join(root, 'saved.json'), path.join(root, 'current.json'));
  await assert.rejects(() => publishPackVersion({ root, versionId: 'v2', build: build('two'), validate }), /unsafe pack pointer/);
  assert.throws(() => rollbackPack(root), /unsafe pack pointer/);
  assert.throws(() => resolveCurrentPack(root), /unsafe pack pointer/);
});

test('unsupported pointer versions cannot be reused or rolled back', async (t) => {
  const root = makeTmpDir(t, 'pack-pointer-version');
  await publishPackVersion({ root, versionId: 'v1', build: build('one'), validate });
  const pointerFile = path.join(root, 'current.json');
  const pointer = JSON.parse(fs.readFileSync(pointerFile, 'utf8'));
  pointer.version += 1;
  fs.writeFileSync(pointerFile, JSON.stringify(pointer));
  await assert.rejects(() => publishPackVersion({ root, versionId: 'v1', reuseExisting: true, build: build('one'), validate }), /unsupported shape/);
  await assert.rejects(() => publishPackVersion({ root, versionId: 'v2', build: build('two'), validate }), /unsupported shape/);
  assert.throws(() => rollbackPack(root), /unsupported shape/);
  assert.deepEqual(fs.readdirSync(path.join(root, '.versions')), ['v1']);
});

test('rollback and reuse reject altered or unpinned versions without updating the pointer', async (t) => {
  const root = makeTmpDir(t, 'pack-content');
  await publishPackVersion({ root, versionId: 'v1', build: build('one'), validate });
  await publishPackVersion({ root, versionId: 'v2', build: build('two'), validate });
  const before = fs.readFileSync(path.join(root, 'current.json'));
  fs.writeFileSync(path.join(root, '.versions', 'v1', 'assets', 'value.txt'), 'tampered');
  assert.throws(() => rollbackPack(root), /content identity mismatch/);
  await assert.rejects(() => publishPackVersion({ root, versionId: 'v1', reuseExisting: true, build: build('one'), validate }), /content identity mismatch/);
  assert.deepEqual(fs.readFileSync(path.join(root, 'current.json')), before);
  fs.mkdirSync(path.join(root, '.versions', 'orphan'));
  await assert.rejects(() => publishPackVersion({ root, versionId: 'orphan', reuseExisting: true, build: build('x'), validate }), /content identity mismatch/);
  assert.throws(() => rollbackPack(root, 'orphan'), /content identity mismatch/);
  fs.rmSync(path.join(root, '.versions', 'v1'), { recursive: true });
  fs.symlinkSync(path.join(root, '.versions', 'v2'), path.join(root, '.versions', 'v1'));
  assert.throws(() => rollbackPack(root), /unsafe pack version/);
  assert.deepEqual(fs.readFileSync(path.join(root, 'current.json')), before);
});

test('reuse compares the full requested pack with the pinned existing version', async (t) => {
  const root = makeTmpDir(t, 'pack-requested-identity');
  await publishPackVersion({ root, versionId: 'v1', build: build('one'), validate });
  await publishPackVersion({ root, versionId: 'v2', build: build('two'), validate });
  const before = fs.readFileSync(path.join(root, 'current.json'));
  await assert.rejects(() => publishPackVersion({ root, versionId: 'v1', reuseExisting: true, build: build('different'), validate }), /requested content identity mismatch/);
  assert.deepEqual(fs.readFileSync(path.join(root, 'current.json')), before);
  const reused = await publishPackVersion({ root, versionId: 'v1', reuseExisting: true, build: build('one'), validate });
  assert.equal(reused.reused, true);
  assert.equal(resolveCurrentPack(root).pointer.currentVersion, 'v1');
});
