import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { startWorkbenchServer } from '../src/workbench-server.mjs';
import { readFixture } from './helpers.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');
const plan = sha('plan');
async function fixture(t) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'moth-workbench-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const source = readFixture('tile.png');
  const result = readFixture('sky.png');
  await writeFile(join(workspaceRoot, 'source.png'), source);
  await writeFile(join(workspaceRoot, 'result.png'), result);
  await mkdir(join(workspaceRoot, 'candidates'));
  await writeFile(join(workspaceRoot, 'candidates', 'sample.json'), JSON.stringify({ version: 1, id: 'sample', kind: 'image', source: { path: 'source.png', sha256: sha(source) }, result: { path: 'result.png', sha256: sha(result) }, params: {}, parameterDelta: {}, backend: 'local', provenance: { engine: 'fixture', planFingerprint: plan }, qualityReport: { warnings: [] }, favorite: false, rejected: false, notes: '' }));
  const app = await startWorkbenchServer({ workspaceRoot });
  t.after(() => app.close());
  return { ...app, workspaceRoot };
}

test('loopback bind, empty candidates and accessible static UI', async t => {
  const root = await mkdtemp(join(tmpdir(), 'moth-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(startWorkbenchServer({ workspaceRoot: root, host: '0.0.0.0' }), /loopback/i);
  const app = await startWorkbenchServer({ workspaceRoot: root });
  t.after(() => app.close());
  const list = await fetch(`${app.url}/api/candidates`);
  assert.deepEqual((await list.json()).candidates, []);
  const html = await (await fetch(app.url)).text();
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /<main>/);
  const js = await (await fetch(`${app.url}/app.js`)).text();
  assert.match(js, /aria-label/);
  assert.match(js, /No candidates yet/);
});

test('candidate GET, hash-checked media, approval, and protected mutations', async t => {
  const app = await fixture(t);
  const base = `${app.url}/api/candidates/sample`;
  const html = await (await fetch(app.url)).text();
  const token = /name="workbench-token" content="([a-f0-9]+)"/.exec(html)?.[1];
  assert.ok(token);
  assert.equal((await (await fetch(`${app.url}/api/candidates`)).json()).candidates[0].id, 'sample');
  assert.equal((await (await fetch(base)).json()).candidate.id, 'sample');
  assert.deepEqual(Buffer.from(await (await fetch(`${base}/result`)).arrayBuffer()), readFixture('sky.png'));
  const post = (path, headers = {}, data = { value: true }) => fetch(`${base}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: app.url, ...headers }, body: JSON.stringify(data) });
  assert.equal((await post('favorite')).status, 403);
  assert.equal((await post('favorite', { 'X-Workbench-Token': 'wrong' })).status, 403);
  assert.equal((await post('favorite', { Origin: 'https://evil.example', 'X-Workbench-Token': token })).status, 403);
  assert.equal((await post('favorite', { 'X-Workbench-Token': token })).status, 200);
  assert.equal((await (await fetch(base)).json()).candidate.favorite, true);
  assert.equal((await post('approve', { 'X-Workbench-Token': token }, { planFingerprint: sha('unrelated') })).status, 400);
  assert.equal((await post('approve', { 'X-Workbench-Token': token }, { planFingerprint: plan })).status, 200);
  assert.equal((await post('approve', { 'X-Workbench-Token': token }, { planFingerprint: sha('plan') })).status, 409);
  assert.equal((await post('supersede', { 'X-Workbench-Token': token }, { planFingerprint: sha('plan2') })).status, 400);
  assert.equal((await post('supersede', { 'X-Workbench-Token': token }, { planFingerprint: plan })).status, 200);
  assert.equal((await post('reject', { 'X-Workbench-Token': token })).status, 200);
  assert.equal((await post('supersede', { 'X-Workbench-Token': token }, { planFingerprint: plan })).status, 400);
  const oversized = await fetch(`${base}/note`, { method: 'POST', headers: { Origin: app.url, 'X-Workbench-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ notes: 'x'.repeat(17_000) }) });
  assert.equal(oversized.status, 413);
  const badHost = await new Promise((resolve, reject) => {
    http.get(`${app.url}/api/candidates`, { headers: { Host: 'evil.example' } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    }).on('error', reject);
  });
  assert.equal(badHost, 403);
  assert.equal((await fetch(`${app.url}/api/candidates/%2e%2e%2fetc%2fpasswd`)).status, 400);
});

test('no secret exposure on errors or static paths', async t => {
  const app = await fixture(t);
  process.env.WORKBENCH_TEST_SECRET = 'do-not-expose-credential';
  t.after(() => { delete process.env.WORKBENCH_TEST_SECRET; });
  for (const path of ['/api/candidates/missing', '/.env', '/api/candidates/sample/../../.env']) {
    const response = await fetch(app.url + path);
    assert.notEqual(response.status, 200);
    assert.doesNotMatch(await response.text(), /do-not-expose-credential/);
  }
});

test('corrupted media is hidden from index and refused in detail and approval', async t => {
  const app = await fixture(t);
  await writeFile(join(app.workspaceRoot, 'result.png'), Buffer.from('tampered'));
  assert.deepEqual((await (await fetch(`${app.url}/api/candidates`)).json()).candidates, []);
  assert.equal((await fetch(`${app.url}/api/candidates/sample`)).status, 400);
  assert.equal((await fetch(`${app.url}/api/candidates/sample/result`)).status, 400);
  const html = await (await fetch(app.url)).text();
  const token = /name="workbench-token" content="([a-f0-9]+)"/.exec(html)?.[1];
  const approval = await fetch(`${app.url}/api/candidates/sample/approve`, { method: 'POST', headers: { Origin: app.url, 'X-Workbench-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ planFingerprint: sha('plan') }) });
  assert.equal(approval.status, 400);
  assert.equal((await (await fetch(`${app.url}/api/approval`)).json()).approval, null);
});

test('signature-only image with a matching hash is not listed or approvable', async t => {
  const app = await fixture(t);
  const fake = Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex');
  await writeFile(join(app.workspaceRoot, 'result.png'), fake);
  const record = JSON.parse(await readFile(join(app.workspaceRoot, 'candidates', 'sample.json'), 'utf8'));
  record.result.sha256 = sha(fake);
  await writeFile(join(app.workspaceRoot, 'candidates', 'sample.json'), JSON.stringify(record));
  assert.deepEqual((await (await fetch(`${app.url}/api/candidates`)).json()).candidates, []);
  const html = await (await fetch(app.url)).text();
  const token = /name="workbench-token" content="([a-f0-9]+)"/.exec(html)?.[1];
  const response = await fetch(`${app.url}/api/candidates/sample/approve`, {
    method: 'POST', headers: { Origin: app.url, 'X-Workbench-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ planFingerprint: plan }),
  });
  assert.equal(response.status, 400);
  assert.equal((await (await fetch(`${app.url}/api/approval`)).json()).approval, null);
});
