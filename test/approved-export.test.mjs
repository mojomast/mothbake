import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApprovalStore } from '../src/approvals.mjs';
import { exportApprovedCandidate } from '../src/approved-export.mjs';
import { createCandidateStore } from '../src/candidates.mjs';
import { resolveCurrentPack } from '../src/transactional-pack.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('only deliberate approval and supersession change the transactional delivery', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mothbake-approved-export-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const assets = path.join(root, 'assets');
  await fs.mkdir(assets);
  const store = createCandidateStore({ workspaceRoot: root });
  const plan1 = hash('plan-1'), plan2 = hash('plan-2');
  const make = async (id, byte) => {
    const source = Buffer.from(JSON.stringify({ source: byte })), result = Buffer.from(JSON.stringify({ result: byte }));
    await fs.writeFile(path.join(assets, `${id}-source.json`), source);
    await fs.writeFile(path.join(assets, `${id}-result.json`), result);
    const candidate = { version: 1, id, kind: 'material', source: { path: `assets/${id}-source.json`, sha256: hash(source) }, result: { path: `assets/${id}-result.json`, sha256: hash(result) }, params: { byte }, parameterDelta: {}, backend: 'local', provenance: { id, planFingerprint: id === 'first' ? plan1 : plan2 }, qualityReport: {}, favorite: false, rejected: false, notes: '' };
    await store.addCandidate(candidate);
    return candidate;
  };
  const first = await make('first', 1);
  const second = await make('second', 2);
  const approvals = createApprovalStore({ workspaceRoot: root });
  await approvals.approve(first, plan1);
  await exportApprovedCandidate({ workspaceRoot: root });
  const firstVersion = resolveCurrentPack(path.join(root, 'delivery')).pointer.currentVersion;

  // Preparing and annotating another candidate cannot replace delivery.
  await store.mutateMetadata(second.id, { favorite: true });
  assert.equal(resolveCurrentPack(path.join(root, 'delivery')).pointer.currentVersion, firstVersion);
  await exportApprovedCandidate({ workspaceRoot: root });
  assert.equal(resolveCurrentPack(path.join(root, 'delivery')).pointer.currentVersion, firstVersion);

  await approvals.supersede(second, plan2);
  await exportApprovedCandidate({ workspaceRoot: root });
  const current = resolveCurrentPack(path.join(root, 'delivery'));
  assert.notEqual(current.pointer.currentVersion, firstVersion);
  assert.equal(current.pointer.previousVersion, firstVersion);
  const manifest = JSON.parse(await fs.readFile(path.join(current.directory, 'manifest.json')));
  assert.equal(manifest.candidateId, 'second');
  assert.equal(manifest.planFingerprint, plan2);
});

test('export identity includes approval and source even when result bytes match; reuse verifies every byte', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mothbake-export-identity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'assets'));
  const store = createCandidateStore({ workspaceRoot: root });
  const approvals = createApprovalStore({ workspaceRoot: root });
  const result = Buffer.from('{"result":true}');
  const make = async (id) => {
    const planFingerprint = hash(`plan-${id}`);
    const source = Buffer.from(JSON.stringify({ source: id }));
    await fs.writeFile(path.join(root, 'assets', `${id}.json`), source);
    await fs.writeFile(path.join(root, 'assets', `${id}-result.json`), result);
    const candidate = { version: 1, id, kind: 'material', source: { path: `assets/${id}.json`, sha256: hash(source) }, result: { path: `assets/${id}-result.json`, sha256: hash(result) }, params: {}, parameterDelta: {}, backend: 'local', provenance: { planFingerprint }, qualityReport: {}, favorite: false, rejected: false, notes: '' };
    await store.addCandidate(candidate);
    return { candidate, planFingerprint };
  };
  const first = await make('first');
  await approvals.approve(first.candidate, first.planFingerprint);
  await exportApprovedCandidate({ workspaceRoot: root });
  const delivery = path.join(root, 'delivery');
  const original = resolveCurrentPack(delivery);
  const firstManifest = path.join(original.directory, 'manifest.json');
  const originalManifest = await fs.readFile(firstManifest);
  await fs.writeFile(firstManifest, JSON.stringify({ candidateId: 'forged' }));
  await assert.rejects(() => exportApprovedCandidate({ workspaceRoot: root }), /content identity mismatch/);
  assert.equal(JSON.parse(await fs.readFile(path.join(delivery, 'current.json'))).currentVersion, original.pointer.currentVersion);
  await fs.writeFile(firstManifest, originalManifest);
  const firstAsset = path.join(original.directory, 'assets', 'source.json');
  const originalAsset = await fs.readFile(firstAsset);
  await fs.writeFile(firstAsset, '{}');
  await assert.rejects(() => exportApprovedCandidate({ workspaceRoot: root }), /content identity mismatch/);
  await fs.writeFile(firstAsset, originalAsset);
  const second = await make('second');
  await approvals.supersede(second.candidate, second.planFingerprint);
  await exportApprovedCandidate({ workspaceRoot: root });
  const current = resolveCurrentPack(delivery);
  assert.notEqual(current.pointer.currentVersion, original.pointer.currentVersion);
  assert.equal(current.pointer.previousVersion, original.pointer.currentVersion);
  assert.equal(JSON.parse(await fs.readFile(path.join(current.directory, 'manifest.json'))).candidateId, 'second');
});
