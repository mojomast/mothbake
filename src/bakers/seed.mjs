// seed: extract random bytes and the verifiable certificate from a quantum
// randomness result. An emulator can legitimately return zero extractable
// bytes (the ordering penalty can consume the entropy budget); the record is
// still emitted with `seed: null` and a full certificate.

import { outputOf } from './util.mjs';

export const type = 'seed';
export const defaultBucket = 'seeds';

export function bake(job, ctx) {
  const options = ctx.bake ?? {};
  const output = outputOf(ctx.result) || {};
  const random = output.random || {};
  const hex = typeof random.hex === 'string' && /^[0-9a-f]+$/i.test(random.hex) ? random.hex.toLowerCase() : '';
  const bell = output.bell_witness && typeof output.bell_witness.S === 'number' ? Math.round(output.bell_witness.S * 1e6) / 1e6 : null;
  const report = output.entropy_report || output.entropy || null;
  const outputBits = report && Number.isFinite(report.output_bits) ? report.output_bits : random.bytes ? random.bytes * 8 : 0;
  const commitment = output.commitment?.commit || output.pulse?.commitment?.commit || null;
  const hexChars = options.hexChars ?? 8;
  const value = {
    seed: hex.length >= hexChars ? parseInt(hex.slice(0, hexChars), 16) >>> 0 : null,
    hex: hex || null,
    bytes: Number.isFinite(random.bytes) ? random.bytes : hex ? hex.length / 2 : 0,
    bell,
    classicalBound: output.bell_witness?.classical_bound ?? null,
    commitment,
    outputBits,
    backend: output.provenance?.backend ?? null,
    mode: output.provenance?.mode ?? output.mode ?? null,
    certificate: {
      commitment,
      bellWitness: bell,
      classicalBound: output.bell_witness?.classical_bound ?? null,
      outputBits,
      hBit: report && Number.isFinite(report.h_bit) ? report.h_bit : null,
      grade: report?.grade ?? null,
      healthPassed: report?.health_passed ?? null,
      witnessViolatesClassical: report?.witness_violates_classical ?? null,
    },
  };
  return { bucket: options.bucket ?? defaultBucket, key: options.name ?? job.id, value };
}
