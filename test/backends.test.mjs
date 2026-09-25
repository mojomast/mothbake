import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { probeQuantumBlur, runQuantumBlur, QUANTUMBLUR_ID } from '../src/backends/quantumblur.mjs';

const python = '/usr/bin/python3';
test('probe reports absent interpreter/dependencies as unavailable', async () => {
  assert.equal((await probeQuantumBlur()).available, false);
  const result = await probeQuantumBlur({ python });
  assert.equal(typeof result.available, 'boolean');
  assert.equal(result.backend, QUANTUMBLUR_ID);
  if (!result.available) assert.match(result.reason, /required|failed/);
});

test('validates rectangular grids, values, xi, axis and qubit cap before process start', async () => {
  const invalid = [
    { grid: [[1], [1, 2]], xi: 0 }, { grid: [[-1]], xi: 0 },
    { grid: [[Infinity]], xi: 0 }, { grid: [[1]], xi: 1.1 },
    { grid: [[1]], xi: 0, axis: 'z' }, { grid: [[2, 1], [1, 1]], xi: 0 },
    { grid: Array.from({ length: 1025 }, () => [1, 1, 1, 1]), xi: 0 },
  ];
  for (const request of invalid) await assert.rejects(runQuantumBlur(request, { python }));
});

test('fake backend execution maps a bounded local result and provenance', async () => {
  const grid = [[0, 0.25], [0.5, 1]];
  const result = await runQuantumBlur({ grid, xi: 0.4, locality: 0.8, axis: 'y' }, {
    python,
    runBackend: async (request) => ({
      ok: true, backend: QUANTUMBLUR_ID, width: request.width, height: request.height,
      values: request.values.map((value) => value / 2), provenance: { python: 'fixture', verification: 'handcrafted-offline' },
    }),
  });
  assert.deepEqual(result.output, [[0, 0.125], [0.25, 0.5]]);
  assert.equal(result.provenance.backend, QUANTUMBLUR_ID);
  assert.equal(result.provenance.axis, 'y');
});

test('registry reports implemented QuantumBlur and deferred Quantum Audio honestly', async () => {
  const { probeBackends } = await import('../src/backends/index.mjs');
  const report = await probeBackends({ python, runBackend: async () => ({ ok: true, backend: QUANTUMBLUR_ID, available: true, reason: null }) });
  assert.equal(report.backends[0].available, true);
  assert.equal(report.backends[1].implemented, false);
  assert.match(report.backends[1].reason, /not Atlas qrc-audio-v1/);
});

test('offline fixture preserves raw grid and normal-map compatibility', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/quantumblur-input.json', import.meta.url)));
  const expected = JSON.parse(await readFile(new URL('./fixtures/quantumblur-output.json', import.meta.url)));
  assert.deepEqual(fixture.grid, expected.rawGrid);
  assert.deepEqual(fixture.grid, expected.normalMap);
  assert.deepEqual(fixture.grid.flat(), [0, 0.25, 0.5, 1]);
});

test('registry identifies a local backend without hosted fallback', async () => {
  const { backends, getBackend } = await import('../src/backends/index.mjs');
  assert.equal(getBackend(QUANTUMBLUR_ID)?.id, QUANTUMBLUR_ID);
  assert.equal(backends.some(({ id }) => id.startsWith('local:')), true);
});
