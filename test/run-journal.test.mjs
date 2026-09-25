import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openRunJournal, readRunJournal, JOURNAL_VERSION } from '../src/run-journal.mjs';

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mothbake-journal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const file = (dir, name) => path.join(dir, name);
const options = { clock: () => 1_700_000_000_000, pid: 12345, hostname: 'test-host' };

test('persists exact versioned JSON and bounded history, reopens cleanly', (t) => {
  const dir = temp(t);
  const journal = openRunJournal(dir, options);
  assert.deepEqual(journal.snapshot(), { version: JOURNAL_VERSION, jobs: {} });
  const first = journal.transition('a', 'prepared', { detail: 'inputs ready' });
  assert.deepEqual(first, { state: 'prepared', jobId: null, metadata: {}, history: [{ state: 'prepared', at: '2023-11-14T22:13:20.000Z', detail: 'inputs ready' }] });
  first.history.pop();
  assert.equal(journal.get('a').history.length, 1, 'returned objects cannot mutate the journal');
  for (let i = 0; i < 40; i++) journal.transition('a', 'polling');
  const data = journal.snapshot();
  assert.equal(data.jobs.a.history.length, 32);
  assert.deepEqual(Object.keys(data), ['version', 'jobs']);
  assert.equal(fs.readFileSync(file(dir, 'run-journal.json'), 'utf8'), `${JSON.stringify(data, null, 2)}\n`);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['run-journal.json', 'run-journal.lock']);
  assert.deepEqual(readRunJournal(dir), data);
  journal.close();
  assert.ok(!fs.existsSync(file(dir, 'run-journal.lock')));
  const reopened = openRunJournal(dir, options);
  assert.deepEqual(reopened.snapshot(), data);
  reopened.close();
});

test('remote ID survives later local failures and reopen', (t) => {
  const dir = temp(t);
  const journal = openRunJournal(dir, options);
  assert.throws(() => journal.transition('a', 'submitted'), /requires a jobId/);
  journal.transition('a', 'submitting');
  journal.transition('a', 'submitted', { jobId: 'remote-42', metadata: { recipeFingerprint: 'recipe-a' } });
  journal.transition('a', 'completed');
  journal.transition('a', 'local-failed', { detail: 'disk full' });
  journal.close();
  const reopened = openRunJournal(dir, options);
  assert.equal(reopened.get('a').jobId, 'remote-42');
  assert.equal(reopened.get('a').state, 'local-failed');
  assert.equal(reopened.get('a').metadata.recipeFingerprint, 'recipe-a');
  reopened.close();
});

test('unknown submission is durable without a remote ID', (t) => {
  const dir = temp(t);
  const journal = openRunJournal(dir, options);
  journal.transition('a', 'prepared');
  journal.transition('a', 'submitting');
  journal.transition('a', 'unknown-submission', { detail: 'request timed out' });
  journal.close();
  const reopened = openRunJournal(dir, options);
  assert.deepEqual(reopened.get('a'), {
    state: 'unknown-submission', jobId: null, metadata: {},
    history: [
      { state: 'prepared', at: '2023-11-14T22:13:20.000Z' },
      { state: 'submitting', at: '2023-11-14T22:13:20.000Z' },
      { state: 'unknown-submission', at: '2023-11-14T22:13:20.000Z', detail: 'request timed out' },
    ],
  });
  reopened.close();
});

test('active and corrupt locks fail closed; only owner releases its lock', (t) => {
  const dir = temp(t);
  const journal = openRunJournal(dir, options);
  assert.throws(() => openRunJournal(dir, options), /locked/);
  assert.throws(() => openRunJournal(dir, { ...options, breakLock: true, isProcessAlive: () => false }), /active/);
  const original = fs.readFileSync(file(dir, 'run-journal.lock'), 'utf8');
  fs.unlinkSync(file(dir, 'run-journal.lock'));
  fs.writeFileSync(file(dir, 'run-journal.lock'), original);
  assert.throws(() => journal.close(), /no longer owned/);
  assert.ok(fs.existsSync(file(dir, 'run-journal.lock')));
  fs.writeFileSync(file(dir, 'run-journal.lock'), '{broken');
  assert.throws(() => openRunJournal(dir, { ...options, breakLock: true }), /invalid run journal lock/);
  assert.equal(fs.readFileSync(file(dir, 'run-journal.lock'), 'utf8'), '{broken');
});

test('explicit stale break requires age, same host, and confirmed dead PID', (t) => {
  const dir = temp(t);
  const old = openRunJournal(dir, options);
  const newer = { ...options, clock: () => options.clock() + 3_600_001, isProcessAlive: () => false, breakLock: true };
  assert.throws(() => openRunJournal(dir, { ...newer, hostname: 'other-host' }), /active/);
  assert.throws(() => openRunJournal(dir, { ...newer, isProcessAlive: () => true }), /active/);
  assert.throws(() => openRunJournal(dir, { ...newer, clock: () => options.clock() + 100 }), /active/);
  const replacement = openRunJournal(dir, newer);
  assert.throws(() => old.transition('a', 'prepared'), /no longer owned/);
  assert.throws(() => old.close(), /no longer owned/);
  replacement.transition('a', 'prepared');
  replacement.close();
});

test('stale break detects a lock replaced during liveness checking', (t) => {
  const dir = temp(t);
  const old = openRunJournal(dir, options);
  const lock = file(dir, 'run-journal.lock');
  const oldBytes = fs.readFileSync(lock, 'utf8');
  assert.throws(() => openRunJournal(dir, {
    ...options, clock: () => options.clock() + 3_600_001, breakLock: true,
    isProcessAlive: () => {
      fs.unlinkSync(lock);
      fs.writeFileSync(lock, oldBytes);
      return false;
    },
  }), /changed while breaking/);
  assert.equal(fs.readFileSync(lock, 'utf8'), oldBytes);
  assert.throws(() => old.close(), /no longer owned/);
});

test('stale recovery serializes a competing creator and owner release', (t) => {
  const dir = temp(t);
  const old = openRunJournal(dir, options);
  const newer = { ...options, clock: () => options.clock() + 3_600_001, breakLock: true };
  let checked = false;
  const replacement = openRunJournal(dir, {
    ...newer,
    isProcessAlive() {
      checked = true;
      assert.throws(() => openRunJournal(dir, options), /acquisition locked/);
      assert.throws(() => old.close(), /acquisition locked/);
      return false;
    },
  });
  assert.ok(checked);
  assert.throws(() => old.close(), /no longer owned/);
  assert.throws(() => openRunJournal(dir, { ...newer, isProcessAlive: () => false }), /active/);
  replacement.transition('safe', 'prepared');
  replacement.close();
  assert.equal(readRunJournal(dir).jobs.safe.state, 'prepared');
  assert.ok(!fs.existsSync(file(dir, 'run-journal.acquire.lock')));
});

test('corrupt journals and unsupported versions fail closed without overwriting bytes or leaving locks', (t) => {
  const dir = temp(t);
  for (const bytes of ['{broken', '{"version":2,"jobs":{}}', '{"version":1,"jobs":{"a":{"state":"submitted","jobId":null,"metadata":{},"history":[]}}}']) {
    fs.writeFileSync(file(dir, 'run-journal.json'), bytes);
    assert.throws(() => openRunJournal(dir, options), /corrupt run journal/);
    assert.equal(fs.readFileSync(file(dir, 'run-journal.json'), 'utf8'), bytes);
    assert.ok(!fs.existsSync(file(dir, 'run-journal.lock')));
  }
});
