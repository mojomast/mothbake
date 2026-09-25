import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildGarbageReport, collectReferences, GC_REPORT_VERSION } from '../src/gc.mjs';
import { rawArtifactFingerprint } from '../src/identity.mjs';

function workspace(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mothbake-gc-'));
  try { fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const packHash = (contents) => hash(Buffer.from(JSON.stringify(['file', 'asset.bin', contents.length, hash(contents)])));
const asset = (name, sha256 = hash(Buffer.from(name))) => ({ path: `assets/${name}`, sha256 });
const candidate = { version: 1, id: 'one', kind: 'image', source: asset('source.png'), result: asset('result.png'),
  params: {}, parameterDelta: {}, backend: 'local', provenance: {}, qualityReport: {}, favorite: false, rejected: true, notes: '' };
function archived(root, rawName = 'old', bytes = Buffer.from('evidence')) {
  const dir = path.join(root, 'raw', rawName); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'output.bin'), bytes);
  const outputHash = hash(bytes), rawFingerprint = rawArtifactFingerprint({ generation: 'generation', outputs: { result: outputHash }, result: null });
  fs.writeFileSync(path.join(dir, '.mothbake-archive.json'), JSON.stringify({ version: 1, rawName, generationFingerprint: 'generation', rawFingerprint,
    outputs: [{ slot: 'result', file: 'output.bin', bytes: bytes.length, sha256: outputHash }], result: null }));
  return rawFingerprint;
}
const journal = (fp) => ({ version: 1, jobs: { bake: { state: 'completed', jobId: 'remote', metadata: { rawFingerprint: fp }, history: [{ state: 'completed', at: '2026-01-01T00:00:00.000Z' }] } } });
function snapshot(root) {
  const out = [];
  const visit = (dir) => { for (const name of fs.readdirSync(dir)) { const f = path.join(dir, name), st = fs.lstatSync(f);
    if (st.isDirectory()) visit(f); else if (st.isFile()) out.push([path.relative(root, f), fs.readFileSync(f), st.ino, st.mtimeMs]);
  } };
  visit(root); return out;
}

test('report has exact schema, references rejected candidates/current and historical approval and pack versions, and does not mutate files', () => workspace((root) => {
  fs.mkdirSync(path.join(root, 'assets'));
  for (const name of ['source.png', 'result.png', 'history.png', 'loose.png']) fs.writeFileSync(path.join(root, 'assets', name), name);
  fs.mkdirSync(path.join(root, 'candidates'));
  fs.writeFileSync(path.join(root, 'candidates/one.json'), JSON.stringify(candidate));
  fs.writeFileSync(path.join(root, 'approval.lock.json'), JSON.stringify({ version: 1,
    approval: { source: asset('source.png'), result: asset('result.png') },
    history: [{ source: asset('history.png'), result: asset('result.png') }] }));
  const fp = archived(root);
  fs.writeFileSync(path.join(root, 'run-journal.json'), JSON.stringify(journal(fp)));
  fs.mkdirSync(path.join(root, 'delivery/.versions/v1'), { recursive: true });
  fs.mkdirSync(path.join(root, 'delivery/.versions/v2'));
  fs.writeFileSync(path.join(root, 'delivery/.versions/v1/asset.bin'), 'one');
  fs.writeFileSync(path.join(root, 'delivery/.versions/v2/asset.bin'), 'two');
  fs.writeFileSync(path.join(root, 'delivery/current.json'), JSON.stringify({ version: 2, currentVersion: 'v2', previousVersion: 'v1', contentHashes: { v1: packHash(Buffer.from('one')), v2: packHash(Buffer.from('two')) } }));
  const watched = snapshot(root);
  const graph = collectReferences({ workspaceRoot: root });
  const report = buildGarbageReport({ workspaceRoot: root });
  assert.equal(GC_REPORT_VERSION, 1);
  assert.deepEqual(Object.keys(report).sort(), ['bounded', 'canDelete', 'entries', 'generatedAt', 'roots', 'totals', 'version', 'warnings'].sort());
  assert.equal(report.version, 1); assert.equal(Number.isNaN(Date.parse(report.generatedAt)), false); assert.equal(report.canDelete, false);
  assert.notStrictEqual(graph, report, 'collection graph and report rendering are distinct objects');
  assert.ok(report.entries.length > 0);
  for (const e of report.entries) {
    assert.deepEqual(Object.keys(e).sort(), ['bytes', 'disposition', 'path', 'reason', 'referencedBy', 'sha256'].sort());
    assert.ok(Number.isSafeInteger(e.bytes)); assert.ok(['referenced', 'unreferenced', 'unknown'].includes(e.disposition));
    assert.ok(Array.isArray(e.referencedBy)); assert.equal(typeof e.reason, 'string');
    if (e.sha256 !== null) assert.match(e.sha256, /^[a-f0-9]{64}$/);
  }
  const byPath = Object.fromEntries(report.entries.map((e) => [e.path, e]));
  assert.equal(byPath['assets/source.png'].disposition, 'referenced');
  assert.equal(byPath['assets/history.png'].disposition, 'referenced');
  assert.equal(byPath['assets/loose.png'].disposition, 'unreferenced');
  assert.ok(byPath['raw/old/output.bin'].referencedBy.some((r) => r.kind === 'run-journal' && r.id === 'bake'));
  assert.equal(byPath['delivery/.versions/v1/asset.bin'].disposition, 'referenced');
  assert.equal(report.totals.files, report.entries.length);
  assert.equal(report.totals.bytes, report.entries.reduce((n, e) => n + e.bytes, 0));
  assert.equal(report.totals.unknown + report.totals.referenced + report.totals.unreferenced, report.entries.length);
  assert.deepEqual(snapshot(root), watched, 'every file byte sequence, inode and mtime remains unchanged');
}));

test('archive blob hash mismatch, corrupt candidate, unsupported pointer and symlinks stay unknown', () => workspace((root) => {
  fs.mkdirSync(path.join(root, 'assets')); fs.writeFileSync(path.join(root, 'assets/loose.png'), 'x');
  fs.mkdirSync(path.join(root, 'candidates')); fs.writeFileSync(path.join(root, 'candidates/broken.json'), '{');
  const dir = path.join(root, 'raw/bad'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'blob.bin'), 'tampered');
  fs.writeFileSync(path.join(dir, '.mothbake-archive.json'), JSON.stringify({ version: 1, rawName: 'bad', generationFingerprint: 'g', rawFingerprint: 'a'.repeat(64), outputs: [{ slot: 'x', file: 'blob.bin', bytes: 1, sha256: 'a'.repeat(64) }], result: null }));
  fs.mkdirSync(path.join(root, 'delivery/.versions/v1'), { recursive: true }); fs.writeFileSync(path.join(root, 'delivery/.versions/v1/blob'), 'z');
  fs.writeFileSync(path.join(root, 'delivery/current.json'), JSON.stringify({ version: 1, currentVersion: 'v1', previousVersion: null }));
  fs.symlinkSync(os.tmpdir(), path.join(root, 'assets/link'));
  const report = buildGarbageReport({ workspaceRoot: root });
  const byPath = Object.fromEntries(report.entries.map((e) => [e.path, e]));
  assert.equal(byPath['candidates/broken.json'].disposition, 'unknown');
  assert.equal(byPath['assets/loose.png'].disposition, 'unknown');
  assert.equal(byPath['raw/bad/blob.bin'].disposition, 'unknown');
  assert.equal(byPath['delivery/.versions/v1/blob'].disposition, 'unknown');
  assert.equal(byPath['delivery/current.json'].disposition, 'unknown');
  assert.ok(report.warnings.some((w) => w.includes('hash mismatch')));
  assert.ok(report.warnings.some((w) => w.includes('symlink refused')));
  assert.equal(report.canDelete, false);
}));

test('bounded scan and unsafe pack paths never classify unseen evidence as unreferenced', () => workspace((root) => {
  fs.mkdirSync(path.join(root, 'assets')); fs.writeFileSync(path.join(root, 'assets/a.bin'), 'a'); fs.writeFileSync(path.join(root, 'assets/b.bin'), 'b');
  const report = buildGarbageReport({ workspaceRoot: root, maxEntries: 1 });
  assert.equal(report.bounded, true); assert.equal(report.entries.find((e) => e.path === 'assets/a.bin').disposition, 'unknown');
  assert.throws(() => buildGarbageReport({ workspaceRoot: root, maxEntries: 0 }), /positive safe integer/);
}));

test('a delivery tree without a supported root pointer is unknown, never garbage', () => workspace((root) => {
  fs.mkdirSync(path.join(root, 'delivery/godot/versions/v1'), { recursive: true });
  fs.writeFileSync(path.join(root, 'delivery/godot/versions/v1/material.tres'), 'material');
  const report = buildGarbageReport({ workspaceRoot: root });
  const entry = report.entries.find((item) => item.path.endsWith('material.tres'));
  assert.equal(entry.disposition, 'unknown');
  assert.match(entry.reason, /no supported pointer/);
}));
