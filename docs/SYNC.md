# Upstream sync

`mothbake` is the portable, de-branded form of an asset-baking pipeline used by
a private project. The two share every generic mechanism; only naming and the
consuming module shape differ. This page defines how the two are kept in step
and records the current state of the shared surface.

## Maintenance rule

**A capability is not finished upstream until it is ported here.**

Whenever a new decoder, baker, source pattern, value generator, emitter, runner
option or engine integration is added to the upstream pipeline, it must be
brought into this repository in the same change-set, with:

1. **Code** that is de-branded: no project names, canonical asset-kind names,
   engine-specific identifiers or consuming-module shapes.
2. **Tests** under `node --test` that run fully offline against recorded
   fixtures — no network and no API key.
3. **Docs**: an entry in [README.md](../README.md) and
   [ARCHITECTURE.md](ARCHITECTURE.md), plus a note in the sync log below.
4. **An example** when the capability is user-facing (a new pattern, generator,
   baker or emitter option), kept small and reproducible without the paid API.

Conversely, a capability that only makes sense for the private consumer — a
canonical texture-kind name, an engine/parameter choice, a branded identifier,
a private file path or an application-specific module shape — must **not** be
copied here.

The matrix below is the checklist for that rule. "Upstream" is the private
pipeline; "here" is `mothbake`.

## Capability matrix

### Decoders

| Feature | Upstream | Here | Notes |
| --- | --- | --- | --- |
| PNG decode (8-bit, filters 0–4, colour types 0/2/3/4/6, non-interlaced) | yes | yes | Identical raster; here adds structural validation and clearer errors. |
| PNG encode | yes (RGB) | yes (RGB + RGBA) | RGBA encoding is a here-only extension used by the `files` emitter. |
| GIF87a/89a decode (global/local colour tables, LZW, interlace, transparency, disposal 0–3, loop count) | yes | yes | Frames are composited to full-screen RGBA; reserved disposal 4–7 treated as 0. |
| ZIP read (stored + deflate) | yes | yes | Here verifies the local header and inflated size. |
| ZIP write (stored + deflate) | yes | yes | Deterministic classic archive; ZIP64 rejected with a clear error. |
| Radiance RGBE `.hdr` (flat + modern RLE) | yes | yes | Identical maths. |
| WAV inspect | yes | yes | Here also reports container format and frame count. |
| WAV PCM/float decode + encode (8/16/24/32-bit PCM, 32-bit float) | yes | yes | A-law/µ-law/ADPCM and odd bit depths rejected; >8 channels rejected or mixed down. |
| Standard MIDI read/write (format 0/1) | yes | yes | Here handles running status, track chunks and an SMPTE guard. |

### Bakers

| Feature | Upstream | Here | Notes |
| --- | --- | --- | --- |
| `texture-tile` | yes | yes | Options: `slot`, `name`, `bucket`, `size`. |
| `sky` | yes | yes | Equirectangular; `width`, `height`. |
| `material-lut` | yes | yes | Configurable reflectance/transmittance entry suffixes. |
| `normal-map` | yes | yes | `size`, `strength`. |
| `effect-frame` | yes | yes | `name`/`effect` key, `index`, `fps`, `tint`/`ramp`/`ramps`; frames merge by bucket+key. |
| `level-graph` | yes | yes | Adds `maxMeasurements`. |
| `motif` | yes | yes | Adds `maxNotes`, `transpose`, `slot`. |
| `ir` / `ir-descriptor` | yes | yes | Adds `tapsSlot`, `url`, `urlBase`; emits a portable relative `file`. |
| `seed` | yes | yes | Adds `hexChars`; records the full entropy certificate. |
| `sprite-sheet` | yes | yes | Options: `slot`, `name`, `bucket`, `maxWidth`, `powerOfTwo`, `dedupe`. |
| `audio-clip` | yes | yes | Options: `slot`, `name`, `bucket`, `trim`, `threshold`, `pad`, `trimStart`, `trimEnd`, `normalize`, `peak`, `sampleFormat`, `loopStart`, `loopEnd`, `mixdown`, `maxChannels`; here also `embed`, `file`, `url`/`urlBase`, `detectLoop`/`loopSearch`/`loopWindow`/`loopThreshold`, `loopCrossfade`, `targetSampleRate`, `maxSeconds`, `meta`. |
| `audio-stitch` | yes | yes | Ordered WAV concatenation with per-slot `gain`, equal-power `crossfadeMs`, shared descriptor options and loop/crossfade support. |
| `echo-map` | yes | yes | Recursive `extras.taps`/`data.extras.taps` extraction into a compact `{ lattice, sites, depth, seed, count, taps, irFile, irUrl }` record. |
| `raw-grid` | no | yes | Here-only exact numeric inline-grid record; no display scaling or implicit probability normalization. |

### Value generators

| Feature | Upstream | Here | Notes |
| --- | --- | --- | --- |
| `height` (`noise` \| `ridge` \| `cells`) | yes | yes | Byte-identical defaults; `freq`/`octaves`/`angle`/`anisotropy` variety knobs and seed-derived `cells` lattice phases (deliberate 2026-09-24 change: two cell jobs no longer share one lattice). |
| `radial` | yes | yes | Identical. |
| `portal` | yes | yes | Identical. |
| `spark` | yes | yes | Identical. |
| `bloom` | yes | yes | Identical, including `frame` scaling and the fixed seed default. |
| `vortex` | yes | yes | Identical. |
| `contract` | yes | yes | Identical. |
| `rise` | yes | yes | Identical. |
| `shield` | yes | yes | Identical. |
| `snow` | yes | yes | Identical. |
| `dust` | yes | yes | Identical; soft drifting patches, defaults `size 64`, `seed 149`. |
| `flow` | yes | yes | Identical; directional +x streaks via anisotropic wrapping noise, defaults `size 64`, `seed 173`. |

### Source-art patterns

| Feature | Upstream | Here | Notes |
| --- | --- | --- | --- |
| Families: `noise`, `panels`, `rivets`, `circuit`, `stripes`, `corrugated`, `grating`, `diamond`, `weave`, `mesh`, `stars` | yes | yes | Identical renderer. |
| Built-in recipes | yes | yes | 24 recipes; rendered output is byte-for-byte identical. |
| Star-band knobs (`cloudFreq`, `starDensity`) | yes | yes | — |
| Pattern knobs (`panels`, `ribs`, `cells`) | yes | yes | — |
| Configurable recipe set | no | yes | Here-only: recipes can come from config instead of code. |
| Audio seed WAVs (`makeSourceAudio`: `drone`/`noise`/`pulse`) | yes | yes | Deterministic, original mono WAVs from a seed; `sources.audio`. |
| Chunk ZIP builder (`makeChunkZip`, `sources.chunks`) | yes | yes | Splits a WAV into fixed-length chunks and writes them with the deterministic `zip()`. |

### Runner, CLI and config

| Feature | Upstream | Here | Notes |
| --- | --- | --- | --- |
| Recorded fixtures (offline runs) | no | yes | Here-only; used by tests and examples. |
| Durable job recovery and `--force` | partial | yes | Versioned journal persists intent and returned ids before polling. Queued work resumes; completed/archive work rebuilds. `submitting`/unknown outcomes and recipe conflicts require reconciliation. `--force` is fresh intent, never spending approval. |
| Exact spending plan / local budget gate | no | yes | New Moth submissions require the exact frozen `--approve-spend` fingerprint; unknown cost is explicit. This is local admission control, not provider billing enforcement. |
| Offline repair from raw outputs (`repair`) | partial | yes (all built-in bakers) | New archives bind generation, slots and hashes; legacy archives are unverified. Repair takes the same output lock and uses no API/key/credits. `bakes` lets one raw result feed several local transforms. |
| Dry run without network or writes | yes | yes | `run --dry` is text; `plan` emits the complete structured action/spending plan. |
| Stop at the first failure (`strict`) | yes | yes | Library option plus the `--strict` flag. |
| `--only` selection | yes | yes | Accepts repeats/comma-separated ids, validates them and includes transitive `inputFrom` ancestors. |
| `catalog`, `sources`, `run` commands | yes | yes | `catalog --snapshot` writes a sanitized dated contract for preflight validation. |
| `validate` command and config schema checks | no | yes | Here-only. |
| `plan`, `resume`, `rebuild`, `inspect`, `explore`, `approve`, `export`, `workbench` | no | yes | Here-only local workflow and structured review/approval surfaces. |
| Optional local backends (`backends`, `local-blur`) | no | yes | Pinned QuantumBlur is explicit and cannot reach Atlas; Quantum Audio remains a deferred codec, not `qrc-audio-v1`. |
| Read-only GC/reference report | no | yes | Hash/reference/disposition report only; `canDelete:false`, `--apply` refused, corrupt/incomplete state unknown. |
| Custom bakers / generators / emitters from a module config | no | yes | Here-only extension points. |
| Emitters (files / JSON / ESM) | partial | yes | Upstream writes one hard-coded module; here emitters are a registry. |
| Emitter `atlas` (sprite-sheet PNG + JSON sidecar) | partial | yes | Deterministic and idempotent; composes with the other emitters. |
| Emitter `audio-pack` (audio bundle + manifest) | partial | yes | Writes clips/IRs/spaces plus a deterministic `manifest.json`; composes with the other emitters. |
| Emitter `audio-pack-versioned` | no | yes | Transactional complete-pack versions with content hashes and rollback; incomplete/merge publication is refused. |
| Content-pinned candidates/approvals | no | yes | Candidate media and hashes are verified; rejected candidates cannot be approved; supersession retains history. |
| Godot material export | no | yes | Separate API emits aligned textures, material, scene/project and hashes. Runtime import is only passed when an installed Godot probe succeeds. |
| Atomic + exact-JSON validated publication | yes | yes | Emitters write through a same-directory temp file + rename. Aggregates are validated before the write: no NaN/Infinity, `undefined` keys, array holes, cycles or non-plain objects, and provenance for every job whose records the artifact carries. A rejected write leaves the previous artifact byte-identical. |
| Merge-safe publication (opt-in `merge: true`) | yes | yes | Here merge is an emitter option, not a default: `json`, `esm`, `files` (its `index.json`) and `audio-pack` (its manifest) load their previous artifact and overlay this run's records. Keys a partial run did not write keep their previous values; frame records merge by index. Corrupt previous artifacts fail loudly instead of being replaced. |
| Download validation (status, declared content type, empty body) | yes | yes | `res.ok` plus declared-vs-actual content-type (parameters/case ignored) and empty-body rejection. Raw archives are written atomically. |
| Output-asset-id capture + `inputFrom` chaining | yes | yes | Graph-planned dependencies use this run's captured id or freshly verified archived bytes. Persisted mutable ids cannot satisfy a dirty edge. |
| API client (engines, jobs, assets, polling) | yes | yes | Injectable/time-bounded client, paced safe GET retries, ambiguous unsafe POST handling, abort propagation, body limits, redirect credential boundary and output-asset URL refresh. |

**2026-09-24 (here-only integration follow-up).** Added exact `raw-grid`
records, corrected missing mode provenance to `null`, bounded API downloads
and ZIP extraction with corruption/path checks. The offline synthetic example
and [observed workflow notes](OBSERVED_WORKFLOWS.md) distinguish measured
provider results from local processing. This does not introduce global credit
accounting, claim an undocumented engine schema, or redistribute private packs.

## Deliberately not ported

These are private-consumer concerns, so they stay upstream:

- Canonical asset-kind names and the consumer's fixed vocabulary. Here, buckets
  and keys are whatever a config says.
- Engine and parameter choices baked into a job list. Here, jobs are data.
- Branded identifiers, private paths and API credentials.
- The consuming runtime's module shape. Here it is one possible `esm` emitter
  config, not a special case.
- The upstream `repairModule`'s in-place patch of one generated module. Here
  records are data and emitters are a registry, so `mothbake repair` re-runs the
  configured emitters over the rebuilt local records instead of editing a single
  module. It supports every built-in baker from a complete archive; run it with
  `--only` (or a config of those jobs) when you do not want the
  aggregate emitters to contain only the repaired records.

## Output rights

`mothbake` is MIT, but generated-output rights are the user's responsibility:
baked assets remain subject to the terms of whichever upstream service produced
them and to the rights of any source material supplied.

## Sync log

- **2026-09-25** — Local-first workbench upgrade. Replaced mutable-manifest
  execution state with a versioned journal/lock, layered recipe/raw/bake/export
  identities, topological dependency planning, exact spending approval,
  hash-verified archives and all-baker rebuilds. Added bounded variations,
  candidate review/content-pinned approvals, transactional audio/material
  packs, Godot export, contract snapshots, hardened network recovery, read-only
  GC diagnostics, structural media validation and the explicit pinned
  QuantumBlur backend. These are here-only product capabilities; they do not
  change or claim equivalence with hosted Moth engines.

- **2026-09-24** — Rate-limit-safe API usage. Ported the upstream pipeline's
  request queue: every API call now goes through one
  concurrency-1 gate spaced by `MOTH_MIN_INTERVAL_MS` (default 300 ms), and
  failures retry within a bounded budget (`MOTH_MAX_RETRIES` default 5). A `429`
  honours `Retry-After` (seconds or an HTTP date, capped at two minutes);
  otherwise the wait is exponential with jitter (`MOTH_RETRY_BASE_MS` default
  1000, `MOTH_RETRY_CAP_MS` default 30000), each wait logged as
  `rate limited, retrying in Ns`. GETs and non-submit POSTs retry `429`,
  transient `5xx` and transport failures; a job submit retries only `429` and
  otherwise fails closed with a message saying the job may or may not have been
  created, so an automatic retry can never pay twice. Job polling is adaptive:
  base `MOTH_POLL_INTERVAL_MS` (default 1500 ms), growing 1.5x while the status
  marker is unchanged up to `MOTH_POLL_MAX_INTERVAL_MS` (default 5000 ms), reset
  on any transition; the 15-minute timeout is unchanged. Added
  `test/rate-limit.test.mjs` (13 tests: virtual-time pacing and env override,
  `429` with and without `Retry-After` and with an HTTP date, a capped and
  bounded budget, GET retry vs submit fail-closed, adaptive polling with reset,
  ceiling and timeout, and an end-to-end rate-limited run that submits exactly
  once). Exported the new defaults from the package root and extended
  `runConfig` with the `nowImpl`/`randomImpl` test hooks. Updated the README
  ("Rate limits and pacing"), `docs/ARCHITECTURE.md` and this matrix.

- **2026-09-24** — Height variety knobs and the `dust`/`flow` fields. Ported the
  upstream `heightGrid(size, seed, kind, spec)` variety knobs (`freq`, `octaves`,
  `angle`, `anisotropy`) and the missing `dust` and `flow` value generators
  byte-for-byte (`dustGrid`, `flowGrid`; defaults `size 64`, seeds `149`/`173`),
  with `generateValues` now passing the whole height spec through. Added the
  helpers they need to `src/noise.mjs`: `valueNoiseXY`, `tileFbmXY` and
  `smoothRange`. **Deliberate behavior change:** `kind: 'cells'` derives its
  lattice phases from the seed, so two cell jobs no longer render one shared
  lattice; the default `noise`/`ridge` output is byte-identical to the old
  formula (the pre-knob formula is reconstructed and asserted in
  `test/values.test.mjs`, and a 19-case sweep was diffed against the upstream
  module during the port). No existing fixture or example used `kind: 'cells'`,
  so no recorded fixture was invalidated by the change. Tests cover default
  byte-compatibility, each knob's
  effect, the exact seam properties (a quarter-turn rotation is a rotation of
  the unrotated grid; integer anisotropy yields exact repeated bands), seeded
  `cells`, dust/flow determinism, bounds and seed sensitivity, plus the recorded
  example grids against the generators. Examples: `strata-normals` (ridge,
  `freq`/`octaves`), `brushed-normals` (`angle`/`anisotropy`), `dust-frame` and
  `flow-frame`, backed by recorded grid fixtures. Updated the README generator
  table, `docs/ARCHITECTURE.md` and the capability matrix above.
- **2026-09-20** — Merge-safe, atomic and validated publication. Added
  `src/publish.mjs` (`writeFileAtomic`, `assertJsonSafe`, `readJsonArtifact`,
  `readModuleArtifact`, `mergeBundles`, `mergeRecordsIntoBundle`,
  `mergeRecordLists`, `mergeIndex`, `validateForPublish`), the generic form of
  the upstream pipeline's publication hardening. Every emitter now writes
  through a same-directory temp file and rename, and aggregate emitters
  (`json`, `esm`, `files`, `audio-pack`) validate their artifact before writing:
  exact JSON throughout, plus provenance coverage for every job whose records
  the artifact carries; a rejected write leaves the previous artifact
  byte-identical. The aggregate emitters accept an opt-in `merge: true` that
  loads their previous artifact (JSON, or the ESM module's configured export)
  and overlays this run's records key by key, with frame records merging by
  index — so a partial run (`--only`, disabled jobs, failures) or a scoped
  `repair` never drops previously published data. Merge is deliberately an
  emitter option rather than a run-wide flag: only the emitter knows whether
  merging its output is meaningful, so a custom emitter that never opted in is
  unchanged. `src/api.mjs` now also enforces the declared-vs-actual content
  type and rejects empty download bodies, and raw archives plus JSON write-back
  are written atomically. Added `test/publish.test.mjs` (atomic-write
  replacement and temp cleanup, JSON-safety rejection table, artifact loading,
  merge helpers and every merge-capable emitter, corrupt-previous refusal,
  download validation against a stub `fetch`, and an offline CLI run of
  `examples/publish.json` proving a partial run preserves prior records and a
  dry run writes nothing) and extended the CLI `--only` test with a mixed
  valid/unknown comma-separated list. Added `examples/publish.json` and updated
  the README, `docs/ARCHITECTURE.md` and this matrix.
- **2026-09-18** — Offline repair and cached-job safety. Added `src/repair.mjs`
  (`LOCAL_BAKE_TYPES`, `isLocalBake`, `readRawResults`, `rebuildLocalBakes`,
  `repairConfig`) and the `mothbake repair` command. It rebuilds the purely
  local, file-derived records from the raw outputs a run already archived under
  `<out>/raw/<raw>/` and re-runs the configured emitters, with no API key and no
  credits. The local set now covers the file-derived `audio-clip` (`embed: false`,
  writing a WAV beside the descriptor) and `audio-stitch` alongside
  `ir`/`ir-descriptor` and `echo-map`, closing the parity gap with the upstream
  `LOCAL_BAKE_TYPES`/`rebuildLocalBakes` path. Guarded the runner's cached-job
  path: a recorded `jobId` whose status is not `completed` (failed, cancelled,
  running, unknown) — or whose status cannot be verified — is no longer silently
  resubmitted, which would spend credits; the job now fails with a clear message
  that names `--force`. The `completed` reuse path is unchanged. Added
  `test/repair.test.mjs` (local-type coverage, raw-result reading, offline
  rebuild, changed-raw rebuild, determinism, missing-archive errors, CLI
  `--only` and a no-key CLI repair) and extended `test/mock-server.test.mjs` with
  completed-reuse, failed, unknown-status, unverifiable-status and `--force`
  cases. Updated the README, `docs/ARCHITECTURE.md` and this matrix.
- **2026-09-17** — Audio pipeline pass. Extended `audio-clip` with `embed: false`
  plus `file`/`url`/`urlBase` file descriptors, a deterministic `detectLoop`
  seam finder (`loopSearch`/`loopWindow`/`loopThreshold`) with an equal-power
  `loopCrossfade`, `targetSampleRate`/`maxSeconds` size caps and a `meta`
  passthrough. Added the `audio-stitch` baker (ordered WAV concatenation with
  per-slot gain and crossfades) and the `echo-map` baker (recursive
  `extras.taps`/`data.extras.taps` extraction into a compact tap map), and
  factored their shared WAV maths into `src/bakers/audio.mjs`. Added the
  `audio-pack` emitter (clip/IR/spaces files plus a deterministic
  `manifest.json`). Captured `output_asset_id` into the job's saved state and
  provenance, persisted it as `job.assetIds`, and added an `inputFrom`
  mechanism (with config validation) so a later job can reuse an earlier asset
  without re-paying. Added `makeSourceAudio` (deterministic seed WAVs) and
  `makeChunkZip` (chunk archives via `zip()`) to `src/sources.mjs` with
  `sources.audio`/`sources.chunks` config support. Added offline examples for
  the embedded and file-mode `audio-clip`, `audio-stitch`, `echo-map` and the
  `audio-pack` emitter, plus `test/audio.test.mjs` (loop detection, stitching
  order/crossfades, descriptor shape, determinism and error paths) and a mock
  asset-id chaining test. Updated the README, `docs/ARCHITECTURE.md` and this
  matrix.
- **2026-09-17** — Ported the six effect value generators from upstream "Moth
  pass 3": `bloom`, `vortex`, `contract`, `rise`, `shield` and `snow`, byte-for
  byte with the upstream grids (same formulas, constants and per-type seed
  defaults) and registered alongside `height`/`radial`/`portal`/`spark`.
  Exported them from `src/values.mjs` and the package root, and added
  determinism, bounds, seed-sensitivity and per-frame-variation tests. Added
  offline example jobs for each effect (one frame apiece, keyed
  `effect-explosion`, `effect-teleport`, `effect-capture-ring`, `effect-heal`,
  `effect-shield`, `effect-weather-snow`) plus an `open-air` impulse-response
  example with the upstream shared parameters, backed by tiny recorded grid
  fixtures and the existing WAV/tap fixtures. Updated the README generator
  table, `docs/ARCHITECTURE.md` and the capability matrix above.
- **2026-09-17** — Ported the upstream `strict` run option (with the `--strict`
  CLI flag) and the `effect-frame` `effect` key alias. Added offline examples
  for the `portal` and `spark` value generators, extended the source-art example
  across all pattern families, and added tests for each. Recorded this sync
  record and capability matrix.
- **2026-09-17** — Unlocked the animated-image and audio engines. Added a
  dependency-free GIF87a/89a decoder (`src/decoders/gif.mjs`: global/local
  colour tables, LZW, interlacing, transparency, disposal 0–3, NETSCAPE loop
  count), upgraded `src/decoders/wav.mjs` to a real PCM/float decoder plus
  `encodeWav`/`mixdownChannels` while keeping `wavInfo`, and added a
  deterministic ZIP writer (`zip`) beside `unzip` in `src/decoders/zip.mjs`.
  Added the `sprite-sheet` baker (GIF → packed atlas with duplicate-frame
  trimming, max-atlas width and power-of-two padding), the `audio-clip` baker
  (WAV → trimmed, peak-normalised clip with optional loop points) and the
  `atlas` emitter (sprite-sheet PNG + JSON sidecar). Offline tests generate
  tiny fixtures with the system `ffmpeg` and commit them under `test/fixtures/`
  (see `scripts/make-fixtures.sh`); they cover interlace/transparency/disposal,
  pixel-exact packing, PCM round-trips, ZIP round-trips and error paths. Added
  the `walk-sheet` and `sfx-clip` example jobs and the output-rights note.
