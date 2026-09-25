import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApprovalStore } from '../src/approvals.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const plan = sha('frozen-plan');

async function fixture() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mothbake-approval-'));
  const source = Buffer.from('raw source bytes');
  const result = Buffer.from('baked result bytes');
  await fs.writeFile(path.join(workspaceRoot, 'source.bin'), source);
  await fs.writeFile(path.join(workspaceRoot, 'result.bin'), result);
  const candidate = {
    id: 'candidate-1', source: { path: 'source.bin', sha256: sha(source) },
    result: { path: 'result.bin', sha256: sha(result) },
    provenance: { generator: 'recorded', seed: 41, planFingerprint: plan },
  };
  return { workspaceRoot, candidate, cleanup: () => fs.rm(workspaceRoot, { recursive: true, force: true }) };
}

test('approval persists exact bytes, plan and provenance; supersede preserves full history', async () => {
  const { workspaceRoot, candidate, cleanup } = await fixture();
  try {
    const store = createApprovalStore({ workspaceRoot });
    assert.equal(await store.get(), null);
    assert.deepEqual(await store.history(), []);
    await assert.rejects(store.supersede(candidate, plan), /requires an existing approval/);
    const first = await store.approve(candidate, plan);
    assert.equal(first.candidateId, candidate.id);
    assert.deepEqual(first.source, candidate.source);
    assert.deepEqual(first.result, candidate.result);
    assert.deepEqual(first.provenance, candidate.provenance);
    assert.equal(first.planFingerprint, plan);
    assert.ok(!Number.isNaN(Date.parse(first.approvedAt)));
    candidate.provenance.seed = 42;
    const reopened = createApprovalStore({ workspaceRoot });
    assert.deepEqual(await reopened.get(), first);
    await assert.rejects(reopened.approve(candidate, plan), /already exists/);
    const newPlan = sha('new-plan');
    const second = await reopened.supersede({ ...candidate, id: 'candidate-2', provenance: { ...candidate.provenance, planFingerprint: newPlan } }, newPlan);
    assert.equal(second.candidateId, 'candidate-2');
    assert.deepEqual(await store.history(), [first]);
    const disk = JSON.parse(await fs.readFile(path.join(workspaceRoot, 'approval.lock.json'), 'utf8'));
    assert.deepEqual(disk, { version: 1, approval: second, history: [first] });
    const third = await store.supersede({ ...candidate, id: 'candidate-3' }, plan);
    assert.deepEqual(await reopened.history(), [first, second]);
    assert.deepEqual(await reopened.get(), third);
  } finally { await cleanup(); }
});

test('approval refuses stale hashes, invalid fingerprints and escaped paths without replacing current pin', async () => {
  const { workspaceRoot, candidate, cleanup } = await fixture();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mothbake-approval-outside-'));
  try {
    const store = createApprovalStore({ workspaceRoot });
    await assert.rejects(store.approve(candidate, 'not-a-fingerprint'), /planFingerprint/);
    await assert.rejects(store.approve(candidate, sha('unrelated-plan')), /does not match candidate provenance/);
    await assert.rejects(store.approve({ ...candidate, rejected: true }, plan), /rejected candidate/);
    await assert.rejects(store.approve({ ...candidate, source: { ...candidate.source, sha256: sha('wrong') } }, plan), /SHA-256 mismatch/);
    assert.equal(await store.get(), null);
    const first = await store.approve(candidate, plan);
    await fs.writeFile(path.join(workspaceRoot, 'result.bin'), 'altered bytes');
    await assert.rejects(store.supersede(candidate, plan), /SHA-256 mismatch/);
    assert.deepEqual(await store.get(), first);
    await assert.rejects(store.supersede({ ...candidate, source: { ...candidate.source, path: '../elsewhere' } }, plan), /inside workspaceRoot/);
    const external = path.join(outside, 'external.bin');
    await fs.writeFile(external, 'external');
    await fs.symlink(external, path.join(workspaceRoot, 'link.bin'));
    await assert.rejects(store.supersede({ ...candidate, source: { path: 'link.bin', sha256: sha('external') } }, plan), /escapes workspaceRoot/);
    assert.deepEqual(await store.get(), first);
  } finally {
    await cleanup();
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('concurrent approve calls have exactly one winner and never overwrite', async () => {
  const { workspaceRoot, candidate, cleanup } = await fixture();
  try {
    const stores = Array.from({ length: 8 }, () => createApprovalStore({ workspaceRoot }));
    const settled = await Promise.allSettled(stores.map((store, i) => store.approve({ ...candidate, id: `candidate-${i}` }, plan)));
    const winners = settled.filter((item) => item.status === 'fulfilled');
    assert.equal(winners.length, 1);
    for (const failure of settled.filter((item) => item.status === 'rejected')) {
      assert.match(failure.reason.message, /already exists/);
    }
    assert.deepEqual(await stores[0].get(), winners[0].value);
    assert.deepEqual(await stores[0].history(), []);
  } finally { await cleanup(); }
});
