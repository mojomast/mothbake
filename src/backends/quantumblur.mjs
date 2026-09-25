import path from 'node:path';
import { runPythonBackend } from './process.mjs';

export const QUANTUMBLUR_ID = 'local:quantumblur:cecdf5faf08e847c41f5b0aeea923e15803875e8';
export const QUANTUMBLUR_LIMITS = Object.freeze({ maxCells: 4096, maxQubits: 20, timeoutMs: 120_000, maxRequestBytes: 1024 * 1024, maxResponseBytes: 4 * 1024 * 1024 });

function interpreter(options) {
  const python = options?.python;
  if (typeof python !== 'string' || !path.isAbsolute(python)) return null;
  return python;
}

/** An unavailable optional installation is a probe result, not an exception. */
export async function probeQuantumBlur(options = {}) {
  const python = interpreter(options);
  if (!python) return { available: false, backend: QUANTUMBLUR_ID, reason: 'an absolute Python interpreter path is required' };
  try {
    const execute = options.runBackend ?? runPythonBackend;
    const { ok, ...info } = await execute({ operation: 'probe' }, {
      python, signal: options.signal, timeoutMs: options.timeoutMs ?? QUANTUMBLUR_LIMITS.timeoutMs,
    });
    if (info.backend !== QUANTUMBLUR_ID || typeof info.available !== 'boolean') {
      return { available: false, backend: QUANTUMBLUR_ID, reason: 'local QuantumBlur probe returned an unexpected identity or response' };
    }
    return { ...info, available: info.available, reason: info.available ? null : (info.reason || 'QuantumBlur dependencies are unavailable') };
  } catch (error) {
    if (error.code === 'ABORTED') throw error;
    return { available: false, backend: QUANTUMBLUR_ID, reason: `local QuantumBlur probe failed: ${error.message}` };
  }
}

function validate(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('QuantumBlur request must be an object');
  const { grid, xi, locality = 1, axis = 'x' } = request;
  if (!Array.isArray(grid) || !grid.length || !Array.isArray(grid[0]) || !grid[0].length) {
    throw new TypeError('QuantumBlur grid must be a nonempty rectangular array');
  }
  const height = grid.length;
  const width = grid[0].length;
  const qubits = Math.ceil(Math.log2(width)) + Math.ceil(Math.log2(height));
  if (width < 2 || height < 2 || height * width > QUANTUMBLUR_LIMITS.maxCells || qubits > QUANTUMBLUR_LIMITS.maxQubits) {
    throw new RangeError('QuantumBlur grid exceeds cell or qubit limit');
  }
  const values = [];
  for (const row of grid) {
    if (!Array.isArray(row) || row.length !== width) throw new TypeError('QuantumBlur grid must be rectangular');
    for (const value of row) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new TypeError('QuantumBlur grid values must be finite numbers in [0, 1]');
      }
      values.push(value);
    }
  }
  if (typeof xi !== 'number' || !Number.isFinite(xi) || xi < 0 || xi > 1) throw new RangeError('QuantumBlur xi must be in [0, 1]');
  if (typeof locality !== 'number' || !Number.isFinite(locality) || locality < 0 || locality > 1) {
    throw new RangeError('QuantumBlur locality must be in [0, 1]');
  }
  if (axis !== 'x' && axis !== 'y') throw new TypeError('QuantumBlur axis must be x or y');
  if (!values.some((value) => value > 0)) throw new TypeError('QuantumBlur grid must contain a nonzero value');
  return { operation: 'blur', width, height, values, xi, locality, axis };
}

/** Execute only the explicitly selected, pinned local backend. */
export async function runQuantumBlur(request, options = {}) {
  const input = validate(request);
  const python = interpreter(options);
  if (!python) throw new TypeError('QuantumBlur requires an absolute Python interpreter path');
  const execute = options.runBackend ?? runPythonBackend;
  const response = await execute(input, {
    python, signal: options.signal, timeoutMs: options.timeoutMs ?? QUANTUMBLUR_LIMITS.timeoutMs,
  });
  if (response.backend !== QUANTUMBLUR_ID || response.width !== input.width || response.height !== input.height
    || !Array.isArray(response.values) || response.values.length !== input.values.length
    || response.values.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
    throw new Error('local QuantumBlur returned an invalid grid or backend identity');
  }
  const output = Array.from({ length: input.height }, (_, y) => response.values.slice(y * input.width, (y + 1) * input.width));
  return {
    output,
    provenance: { ...response.provenance, backend: QUANTUMBLUR_ID, xi: input.xi, locality: input.locality, axis: input.axis },
  };
}

export const quantumBlurBackend = Object.freeze({
  id: QUANTUMBLUR_ID, name: 'QuantumBlur', kind: 'grid-transform', network: false,
  deterministic: 'deterministic-on-fixed-backend', license: 'Apache-2.0',
  source: 'https://github.com/qiskit-community/QuantumBlur', commit: 'cecdf5faf08e847c41f5b0aeea923e15803875e8',
  limits: QUANTUMBLUR_LIMITS,
  probe: probeQuantumBlur, run: runQuantumBlur,
});
