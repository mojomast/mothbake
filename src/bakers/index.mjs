// Baker registry. A baker is a pure function `(job, ctx) => record fragment`:
//
//   { bucket, key, value, merge?, index?, fps? }
//
// `ctx` carries everything a decoder needs:
//
//   files    Map<slot, Buffer>   decoded output files (from the API or a fixture)
//   saved    Map<slot, { file, relative, contentType }>
//   result   any                 inline job result (JSON)
//   bake     object              the job's bake options (type/name/... included)
//   job      object              the full job definition
//   rawName  string              raw output directory name
//   outDir   string              run output directory
//   configDir string             directory of the loaded config
//   log      (message) => void
//
// Custom bakers can be added from a `mothbake.config.mjs` with
// `bakers: { 'my-type': (job, ctx) => ({ bucket, key, value }) }`.

import * as textureTile from './texture-tile.mjs';
import * as sky from './sky.mjs';
import * as materialLut from './material-lut.mjs';
import * as normalMap from './normal-map.mjs';
import * as effectFrame from './effect-frame.mjs';
import * as levelGraph from './level-graph.mjs';
import * as motif from './motif.mjs';
import * as ir from './ir.mjs';
import * as seed from './seed.mjs';
import * as spriteSheet from './sprite-sheet.mjs';
import * as audioClip from './audio-clip.mjs';

const modules = [textureTile, sky, materialLut, normalMap, effectFrame, levelGraph, motif, ir, seed, spriteSheet, audioClip];

export const bakers = Object.fromEntries(modules.map((module) => [module.type, module.bake]));
// `ir-descriptor` is an explicit alias for the `ir` baker.
bakers['ir-descriptor'] = ir.bake;
export const bakerTypes = Object.keys(bakers);
export const bakerBuckets = Object.fromEntries(modules.map((module) => [module.type, module.defaultBucket]));
bakerBuckets['ir-descriptor'] = ir.defaultBucket;

/**
 * Merge config-provided custom bakers over the built-ins.
 *
 * @param {{ bakers?: Record<string, Function> }} [config]
 */
export function resolveBakers(config = {}) {
  const custom = config.bakers || {};
  for (const [name, fn] of Object.entries(custom)) {
    if (typeof fn !== 'function') throw new Error(`bakers.${name}: must be a function`);
  }
  return { ...bakers, ...custom };
}
