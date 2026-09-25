// Transactional audio pack: build a complete audio-pack in an immutable
// version directory, validate its manifest references, then atomically update
// current.json. The legacy `audio-pack` emitter remains available.

import fs from 'node:fs';
import path from 'node:path';
import { hashJson } from '../identity.mjs';
import { publishPackVersion } from '../transactional-pack.mjs';
import { emit as emitAudioPack } from './audio-pack.mjs';
import { destination } from './files.mjs';

export const name = 'audio-pack-versioned';

function validateAudioPack(dir, required = null) {
  const file = path.join(dir, 'manifest.json');
  if (!fs.existsSync(file)) throw new Error('versioned audio pack has no manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const table of ['clips', 'spaces', 'irs']) {
    for (const key of Object.keys(required?.[table] ?? {})) {
      if (!Object.hasOwn(manifest[table] ?? {}, key)) throw new Error(`versioned audio pack incomplete: missing ${table}.${key}`);
    }
  }
  for (const table of ['clips', 'irs']) for (const entry of Object.values(manifest[table] ?? {})) {
    if (entry.file) {
      const target = destination(dir, entry.file, 'versioned audio pack reference');
      if (!fs.existsSync(target)) throw new Error(`versioned audio pack missing ${entry.file}`);
    }
  }
}

export async function emit(records, ctx) {
  const { outDir, options = {}, provenance = {}, version = 1, generator = 'mothbake', log = () => {} } = ctx;
  const root = destination(outDir, options.dir ?? 'audio-pack', 'versioned audio pack dir', { directory: true });
  if (options.merge) throw new Error('versioned audio pack does not support partial merge; supply complete records');
  if (options.manifest !== undefined && options.manifest !== 'manifest.json') throw new Error('versioned audio pack requires manifest.json');
  const audioTypes = new Set(['audio-clip', 'audio-stitch', 'ir', 'echo-map']);
  for (const job of ctx.config?.jobs ?? []) {
    if (job.enabled === false) continue;
    const bakes = job.bakes ?? (job.bake ? [job.bake] : []);
    const expected = bakes.filter((bake) => audioTypes.has(bake.type)).length;
    if (records.filter((record) => record.job === job.id && audioTypes.has(record.type)).length < expected) {
      throw new Error(`versioned audio pack incomplete: missing audio job ${job.id}`);
    }
  }
  destination(root, '.versions', 'versioned audio pack versions', { directory: true });
  destination(root, '.staging', 'versioned audio pack staging', { directory: true });
  destination(root, 'current.json', 'versioned audio pack pointer');
  const priorPointer = path.join(root, 'current.json');
  let required = null;
  if (fs.existsSync(priorPointer)) {
    const pointer = JSON.parse(fs.readFileSync(priorPointer, 'utf8'));
    if (typeof pointer.currentVersion !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(pointer.currentVersion)) throw new Error('invalid current audio pack version');
    const priorDir = destination(root, `.versions/${pointer.currentVersion}`, 'versioned audio pack prior version', { directory: true });
    validateAudioPack(priorDir);
    required = JSON.parse(fs.readFileSync(path.join(priorDir, 'manifest.json'), 'utf8'));
  }
  const { dir, versionId: configuredVersion, ...packOptions } = options;
  const fingerprint = hashJson({ records, provenance, version, generator, options: packOptions });
  const versionId = configuredVersion ?? `pack-${fingerprint.slice(0, 16)}`;
  const published = await publishPackVersion({
    root,
    versionId,
    reuseExisting: true,
    build: async (staging) => {
      emitAudioPack(records, { ...ctx, outDir: staging, sourceOutDir: outDir, options: { ...packOptions, dir: '', manifest: 'manifest.json', merge: false } });
    },
    validate: async (staging) => validateAudioPack(staging, required),
  });
  const files = [];
  const visit = (dirPath) => {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const file = path.join(dirPath, entry.name);
      if (entry.isDirectory()) visit(file);
      else files.push(file);
    }
  };
  visit(published.directory);
  files.push(path.join(root, 'current.json'));
  log(`transactional audio pack: ${versionId}${published.reused ? ' (reused)' : ''}`);
  return files;
}

export default emit;
