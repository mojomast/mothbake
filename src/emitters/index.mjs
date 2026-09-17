// Emitter registry and resolution.
//
// An emitter is `emit(records, ctx) => filesWritten`, where `ctx` is
// `{ outDir, config, options, provenance, version, generator, log }`.
//
// Config accepts:
//   emitter:  { type: 'esm', file: 'baked.mjs', export: 'ASSETS' }
//   emitters: [ { type: 'files' }, { type: 'json' }, myEmitterFunction ]
//
// Entries may be a built-in name, a `{ type, ...options }` object, or a
// function (from a `mothbake.config.mjs`) implementing the interface above.

import * as files from './files.mjs';
import * as json from './json.mjs';
import * as esm from './esm.mjs';
import * as atlas from './atlas.mjs';
import * as audioPack from './audio-pack.mjs';

export const emitters = {
  files: files.emit,
  json: json.emit,
  esm: esm.emit,
  atlas: atlas.emit,
  'audio-pack': audioPack.emit,
};

export const emitterTypes = Object.keys(emitters);

/**
 * Normalize `config.emitter` / `config.emitters` into a list of
 * `{ name, options, emit }` entries.
 */
export function resolveEmitters(config = {}) {
  const spec = config.emitters ?? (config.emitter !== undefined ? [config.emitter] : [{ type: 'files' }]);
  if (!Array.isArray(spec)) throw new Error('config.emitters must be an array');
  return spec.map((raw, position) => {
    const entry = typeof raw === 'string' ? { type: raw } : raw;
    if (typeof entry === 'function') {
      return { name: entry.name || `custom[${position}]`, options: {}, emit: entry };
    }
    if (entry && typeof entry === 'object' && typeof entry.emit === 'function') {
      const emit = entry.emit.bind(entry);
      return { name: entry.name || `custom[${position}]`, options: entry.options ?? {}, emit };
    }
    if (!entry || typeof entry !== 'object' || typeof entry.type !== 'string') {
      throw new Error(`emitters[${position}]: expected a name, { type, ...options }, or an emit function`);
    }
    const fn = emitters[entry.type];
    if (!fn) {
      throw new Error(`emitters[${position}].type: unknown emitter "${entry.type}" (available: ${emitterTypes.join(', ')})`);
    }
    const { type, ...options } = entry;
    return { name: type, options, emit: (records, ctx) => fn(records, { ...ctx, options }) };
  });
}

/**
 * Run every configured emitter in order and collect the paths written.
 *
 * @param {{
 *   config: object, records: Array, outDir: string,
 *   provenance?: object, version?: number, generator?: string,
 *   log?: (message: string) => void,
 * }} options
 */
export async function runEmitters(options) {
  const { config, records, outDir, provenance = {}, version = 1, generator = 'mothbake', log = () => {} } = options;
  const resolved = resolveEmitters(config);
  const written = [];
  for (const emitter of resolved) {
    const filesWritten = await emitter.emit(records, {
      outDir,
      config,
      options: emitter.options,
      provenance,
      version,
      generator,
      log,
    });
    if (!Array.isArray(filesWritten)) {
      throw new Error(`emitter "${emitter.name}" must return an array of file paths`);
    }
    written.push(...filesWritten);
    log(`emitter ${emitter.name}: wrote ${filesWritten.length} file(s)`);
  }
  return written;
}
