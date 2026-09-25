import test from 'node:test';
import assert from 'node:assert/strict';
import { runLocalProcess, runPythonBackend } from '../../src/backends/process.mjs';

test('local process limits both pipes and times out a stalled child', async () => {
  const base = { command: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(1024))'], maxOutputBytes: 32 };
  await assert.rejects(runLocalProcess(base), { code: 'OUTPUT_LIMIT' });
  await assert.rejects(runLocalProcess({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 50 }), { code: 'TIMEOUT' });
  await assert.rejects(runLocalProcess({ command: process.execPath, args: ['-e', ''], input: 'abcd', maxInputBytes: 3 }), { code: 'INPUT_LIMIT' });
});

test('local process strips ambient secrets and does not run a shell', async () => {
  const key = 'MOTHBAKE_PROCESS_TEST_SECRET';
  process.env[key] = 'sensitive';
  try {
    const { stdout } = await runLocalProcess({ command: process.execPath, args: ['-e', `process.stdout.write(String(process.env.${key}))`] });
    assert.equal(stdout, 'undefined');
    await assert.rejects(runLocalProcess({ command: '/bin/nonexistent;false', args: [] }), { code: 'SPAWN' });
  } finally {
    delete process.env[key];
  }
});

test('Python probe is offline and requires pinned QuantumBlur for blur', async () => {
  const python = '/usr/bin/python3';
  const probe = await runPythonBackend({ operation: 'probe' }, { python });
  assert.match(probe.backend, /^local:quantumblur:[a-f0-9]{40}$/);
  assert.equal(probe.license, 'Apache-2.0');
  await assert.rejects(runPythonBackend({ operation: 'unknown' }, { python }), { code: 'BACKEND' });
});
