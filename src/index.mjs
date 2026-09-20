// Public API. Everything is also importable from its subpath export, e.g.
// `import { decodePng } from 'mothbake/decoders/png'`.

import fs from 'node:fs';

export const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export { decodePng, encodePng, crc32, unzip, zip, decodeHdr, wavInfo, decodeWav, encodeWav, mixdownChannels, decodeGif, decodeMidi, encodeMidi, decoders } from './decoders/index.mjs';
export { bakers, bakerTypes, bakerBuckets, resolveBakers } from './bakers/index.mjs';
export { emitters, emitterTypes, resolveEmitters, runEmitters } from './emitters/index.mjs';
export { bundleRecords, summarizeRecords } from './bundle.mjs';
export { assertJsonSafe, isPlainObject, mergeBundles, mergeIndex, mergeRecordLists, mergeRecordsIntoBundle, readJsonArtifact, readModuleArtifact, validateForPublish, writeFileAtomic } from './publish.mjs';
export { ConfigError, DEFAULT_CONFIG_FILES, assertValidConfig, findConfigFile, formatIssue, loadConfig, validateConfig } from './config.mjs';
export { ApiError, DEFAULT_BASE_URL, createApi, guessContentType, readKey, resolveBaseUrl } from './api.mjs';
export { jobsRequiringApi, normalizeOnly, runConfig, selectJobs } from './runner.mjs';
export { LOCAL_BAKE_TYPES, isLocalBake, readRawResults, rebuildLocalBakes, repairConfig } from './repair.mjs';
export { generateValues, generatorTypes, generators, heightGrid, portalGrid, radialGrid, sparkGrid, bloomGrid, vortexGrid, contractGrid, riseGrid, shieldGrid, snowGrid } from './values.mjs';
export { DEFAULT_AUDIO_SOURCES, DEFAULT_MOTIF, DEFAULT_SOURCE_PATTERNS, audioKinds, makeChunkZip, makeSourceArt, makeSourceAudio, writeSources } from './sources.mjs';
export { RAMPS, fromBase64, gridToNormal, gridToRamp, hdrToRgb8, resampleGrid, resizeNearest, toBase64 } from './image.mjs';
