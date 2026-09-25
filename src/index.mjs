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
export { ApiError, DEFAULT_BASE_URL, DEFAULT_DOWNLOAD_TIMEOUT_MS, DEFAULT_MAX_RETRIES, DEFAULT_MAX_UPLOAD_BYTES, DEFAULT_MIN_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS, DEFAULT_POLL_MAX_INTERVAL_MS, DEFAULT_POLL_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_RETRY_AFTER_CAP_MS, DEFAULT_RETRY_BASE_MS, DEFAULT_RETRY_CAP_MS, DEFAULT_UPLOAD_TIMEOUT_MS, createApi, guessContentType, isTransientNetworkError, readKey, resolveBaseUrl } from './api.mjs';
export { jobsRequiringApi, normalizeOnly, runConfig, selectJobs } from './runner.mjs';
export { LOCAL_BAKE_TYPES, isLocalBake, readRawResults, rebuildLocalBakes, repairConfig } from './repair.mjs';
export { ARCHIVE_MANIFEST, ARCHIVE_VERSION, archiveResponse, readArchive, sanitizeSlot } from './archive.mjs';
export { EXECUTION_PLAN_VERSION, IMPLEMENTATION_ID, assertSpendApproved, buildExecutionPlan } from './execution-plan.mjs';
export { canonicalJson, exportFingerprint, generationInstanceFingerprint, hashBytes, hashFile, hashJson, localBakeFingerprint, rawArtifactFingerprint, recipeFingerprint } from './identity.mjs';
export { buildJobGraph, normalizeInputRef } from './job-graph.mjs';
export { JOURNAL_VERSION, RUN_STATES, openRunJournal, readRunJournal } from './run-journal.mjs';
export { CANDIDATE_VERSION, MAX_CANDIDATE_JSON_BYTES, createCandidateStore, validateCandidate, validateCandidateId, validateCandidatePath } from './candidates.mjs';
export { createApprovalStore } from './approvals.mjs';
export { exportApprovedCandidate } from './approved-export.mjs';
export { startWorkbenchServer } from './workbench-server.mjs';
export { MAX_VARIATIONS, VARIATION_PLAN_VERSION, refineVariationRequest, resolveVariationPlan } from './variations.mjs';
export { analyzeAudioQuality } from './audio-quality.mjs';
export { backends, deferredBackends, getBackend, probeBackends, quantumBlurBackend, probeQuantumBlur, runQuantumBlur, QUANTUMBLUR_ID, QUANTUMBLUR_LIMITS } from './backends/index.mjs';
export { CONTRACT_SNAPSHOT_VERSION, createContractSnapshot, loadContractSnapshot, sanitizeEngineContract, validateContractSnapshot, validateJobsAgainstContracts, writeContractSnapshot } from './engine-contracts.mjs';
export { GC_REPORT_VERSION, buildGarbageReport, collectReferences, reportGcReferences } from './gc.mjs';
export { verifyJpeg, verifyMediaStructure, verifyMp3, verifyOgg, verifyWebp } from './media-structure.mjs';
export { PACK_POINTER_VERSION, inspectPointerShape, publishPackVersion, resolveCurrentPack, rollbackPack } from './transactional-pack.mjs';
export { createMaterialFamily } from './material-family.mjs';
export { exportGodotMaterialFamily, probeGodotPack, readCurrentGodotPack, rollbackGodotMaterialFamily, validateGodotPack } from './emitters/godot.mjs';
export { generateValues, generatorTypes, generators, heightGrid, dustGrid, flowGrid, portalGrid, radialGrid, sparkGrid, bloomGrid, vortexGrid, contractGrid, riseGrid, shieldGrid, snowGrid } from './values.mjs';
export { DEFAULT_AUDIO_SOURCES, DEFAULT_MOTIF, DEFAULT_SOURCE_PATTERNS, audioKinds, makeChunkZip, makeSourceArt, makeSourceAudio, writeSources } from './sources.mjs';
export { RAMPS, boundaryContinuity, fromBase64, gridToNormal, gridToRamp, hdrToRgb8, resampleGrid, resizeBilinear, resizeNearest, toBase64 } from './image.mjs';
