import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildJobGraph, normalizeInputRef } from '../src/job-graph.mjs';

const ids = (graph) => graph.jobs.map((job) => job.id);

test('normalizes shorthand and object references, including default input slot', () => {
  assert.deepEqual(normalizeInputRef('source/result', 'image'), { job: 'source', slot: 'result' });
  assert.deepEqual(normalizeInputRef({ job: 'source' }, 'image'), { job: 'source', slot: 'image' });
  assert.deepEqual(normalizeInputRef({ job: 'source', slot: 'other' }, 'image'), { job: 'source', slot: 'other' });
  assert.throws(() => normalizeInputRef('source', 'image'), /job\/slot/);
});

test('topological order ignores dependency order while preserving unrelated authored order', () => {
  const jobs = [
    { id: 'final', inputFrom: { texture: 'middle/output', mask: { job: 'alpha' } } },
    { id: 'middle', inputFrom: { image: { job: 'zeta' } } },
    { id: 'zeta' }, { id: 'alpha' },
  ];
  const graph = buildJobGraph({ jobs });
  assert.deepEqual(ids(graph), ['alpha', 'zeta', 'middle', 'final']);
  const reordered = buildJobGraph([...jobs].reverse());
  for (const [id, refs] of reordered.dependencies) {
    for (const ref of refs) assert.ok(ids(reordered).indexOf(ref.job) < ids(reordered).indexOf(id));
  }
  assert.deepEqual(ids(buildJobGraph([{ id: 'z' }, { id: 'a' }])), ['z', 'a']);
  assert.deepEqual(graph.dependencies.get('final'), [
    { inputSlot: 'mask', job: 'alpha', slot: 'mask' },
    { inputSlot: 'texture', job: 'middle', slot: 'output' },
  ]);
  assert.match(graph.explain('final'), /enabled/);
});

test('missing jobs and cycles fail with context', () => {
  assert.throws(() => buildJobGraph([{ id: 'child', inputFrom: { img: 'missing/out' } }]), /child.*img.*missing/);
  assert.throws(() => buildJobGraph([
    { id: 'a', inputFrom: { x: 'b/out' } },
    { id: 'b', inputFrom: { x: { job: 'c' } } },
    { id: 'c', inputFrom: { x: 'a/out' } },
  ]), /cycle: a -> b -> c -> a/);
});

test('--only includes transitive ancestors, rejects unknown and disabled ancestors', () => {
  const jobs = [
    { id: 'target', inputFrom: { image: { job: 'middle' } } },
    { id: 'unrelated' },
    { id: 'middle', inputFrom: { mask: 'root/out' } },
    { id: 'root' },
  ];
  const graph = buildJobGraph(jobs, { only: 'target' });
  assert.deepEqual(ids(graph), ['root', 'middle', 'target']);
  assert.match(graph.explain('middle'), /target.*inputFrom "image".*middle\/image/);
  assert.match(graph.explain('root'), /middle.*inputFrom "mask".*root\/out/);
  assert.match(graph.explain('target'), /selected by --only/);
  assert.throws(() => graph.explain('unrelated'), /not selected/);
  assert.deepEqual(ids(buildJobGraph(jobs, { only: ['target,unrelated'] })), ['root', 'middle', 'target', 'unrelated']);
  assert.throws(() => buildJobGraph(jobs, { only: 'unknown' }), /--only.*unknown/);
  assert.throws(() => buildJobGraph(jobs.map((job) => job.id === 'root' ? { ...job, enabled: false } : job), { only: 'target' }), /disabled ancestor "root"/);
  assert.throws(() => buildJobGraph([{ id: 'off', enabled: false }], { only: 'off' }), /disabled/);
});
