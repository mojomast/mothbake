import { probeQuantumBlur, quantumBlurBackend } from './quantumblur.mjs';

export { quantumBlurBackend, probeQuantumBlur, runQuantumBlur, QUANTUMBLUR_ID, QUANTUMBLUR_LIMITS } from './quantumblur.mjs';

/** Explicit local backend registry; no implicit hosted-engine substitution. */
export const backends = Object.freeze([quantumBlurBackend]);

export const deferredBackends = Object.freeze([{
  id: 'local:quantumaudio:0.2.0', name: 'Moth Quantum Audio', kind: 'audio-codec-roundtrip',
  implemented: false, network: false, license: 'Apache-2.0 + NOTICE',
  source: 'https://github.com/moth-quantum/quantum-audio',
  reason: 'Deferred: this optional codec is not Atlas qrc-audio-v1 and its default decode is shot-random.',
}]);

export async function probeBackends(options = {}) {
  const quantumblur = await probeQuantumBlur(options);
  const runnable = Object.fromEntries(Object.entries(quantumBlurBackend).filter(([key]) => !['probe', 'run'].includes(key)));
  return { version: 1, backends: [
    { ...runnable, available: quantumblur.available, reason: quantumblur.reason, runtime: quantumblur },
    { ...deferredBackends[0], available: false },
  ] };
}

export function getBackend(id) {
  return backends.find((backend) => backend.id === id) ?? null;
}
