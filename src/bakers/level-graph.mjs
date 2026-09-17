// level-graph: flatten a quantum labyrinth graph into a compact room grid
// (rows/cols, coupling pairs, per-cell Bloch vector, metrics, measurements).

import { outputOf } from './util.mjs';

export const type = 'level-graph';
export const defaultBucket = 'levels';

const round6 = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : 0);

export function bake(job, ctx) {
  const options = ctx.bake ?? {};
  const output = outputOf(ctx.result);
  if (!output?.grid_size || !output?.coupling_map) {
    throw new Error(`${type}: unexpected result shape (need grid_size and coupling_map)`);
  }
  const { rows, cols } = output.grid_size;
  const maxMeasurements = options.maxMeasurements ?? 8;
  const cells = Array.from({ length: rows * cols }, (_, i) => {
    const state = output.initial_states?.[String(i)] || {};
    return {
      i,
      x: Math.round((state.X || 0) * 1e4) / 1e4,
      y: Math.round((state.Y || 0) * 1e4) / 1e4,
      z: Math.round((state.Z || 0) * 1e4) / 1e4,
      radiating: state.radiating === true,
    };
  });
  const coupling = (output.coupling_map || [])
    .map(([a, b]) => [a, b])
    .sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const measurements = (output.results?.measurements || [])
    .slice(0, maxMeasurements)
    .map((m) => ({ bits: m.bitstring, probability: round6(m.probability || 0) }));
  return {
    bucket: options.bucket ?? defaultBucket,
    key: options.name ?? job.id,
    value: {
      name: output.name ?? null,
      rows,
      cols,
      numQubits: output.num_qubits ?? rows * cols,
      coupling,
      cells,
      measurements,
      metrics: {
        szSamp: round6(output.metrics?.sz_samp || 0),
        mode: output.metrics?.mode || 'emu',
        backend: output.metrics?.backend || 'aer',
        shots: output.metrics?.shots ?? 0,
      },
    },
  };
}
