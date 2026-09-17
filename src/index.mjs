// Public API. Everything is also importable from its subpath export, e.g.
// `import { decodePng } from 'mothbake/decoders/png'`.

import fs from 'node:fs';

export const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export { decodePng, encodePng, crc32, unzip, decodeHdr, wavInfo, decodeMidi, encodeMidi, decoders } from './decoders/index.mjs';
export { bakers, bakerTypes, bakerBuckets, resolveBakers } from './bakers/index.mjs';
export { emitters, emitterTypes, resolveEmitters, runEmitters } from './emitters/index.mjs';
export { bundleRecords, summarizeRecords } from './bundle.mjs';
export { ConfigError, DEFAULT_CONFIG_FILES, assertValidConfig, findConfigFile, formatIssue, loadConfig, validateConfig } from './config.mjs';
export { ApiError, DEFAULT_BASE_URL, createApi, guessContentType, readKey, resolveBaseUrl } from './api.mjs';
export { jobsRequiringApi, normalizeOnly, runConfig, selectJobs } from './runner.mjs';
export { generateValues, generatorTypes, generators, heightGrid, portalGrid, radialGrid, sparkGrid } from './values.mjs';
export { DEFAULT_MOTIF, DEFAULT_SOURCE_PATTERNS, makeSourceArt, writeSources } from './sources.mjs';
export { RAMPS, fromBase64, gridToNormal, gridToRamp, hdrToRgb8, resampleGrid, resizeNearest, toBase64 } from './image.mjs';
