# Architecture

`mothbake` is a local-first pipeline with explicit contracts for **recipes**,
**plans**, **run state**, **raw results**, **records/candidates**, **approvals**
and **exports**. Media transforms remain pure; paid execution state does not
live in authored recipes.

```
recipe ─▶ dependency plan ─▶ run journal ─▶ raw archive ─▶ local bake ─▶ candidates
               │                  │              │                            │
               └── spend gate ────┘              └── offline rebuild         ▼
                                                                    approval lock ─▶ transactional export
```

The identities at each arrow are intentionally different. A recipe fingerprint
cannot certify stochastic output bytes; a local-bake fingerprint depends on the
actual archived content; an export fingerprint depends on baked content and
exporter options. Signed URLs are never identities.

The run journal (`src/run-journal.mjs`) is a versioned atomic JSON file guarded
by an advisory single-host lock. It records prepared, submitting, submitted,
polling, completed, downloaded, baked, published, remote/local failure and
unknown-submission states. A returned job id is persisted before polling.
Unknown submission outcomes never fall through to a new request.

`src/job-graph.mjs` topologically orders `inputFrom` edges and expands `--only`
to include required ancestors. `src/execution-plan.mjs` hashes source bytes and
dependencies, classifies local/archive/resume/submit work and produces the exact
fingerprint required by the spending gate.

New raw directories include `.mothbake-archive.json` with slot hashes,
generation identity and the inline-result hash. `repair` verifies this manifest
and supports every built-in baker. A legacy directory is readable but labelled
unverified.

## Stages

### 1. Config (`src/config.mjs`)

`loadConfig()` finds and loads `mothbake.config.mjs` / `.js` / `mothbake.json`,
and returns `{ config, file, dir, format }`. Modules are imported with a
cache-busting query, so repeated loads in one process are safe.

`validateConfig()` returns `{ errors, warnings }`, each an `{ path, message }`
pair (`jobs[2].bake.type: unknown baker "…"`). Paths are stable enough to test
against. Unknown top-level keys, job keys and bake options are warnings, not
errors: custom bakers and emitters may accept their own options. `ConfigError`
carries the full issue list, which the CLI prints one line at a time.

### 2. Jobs

A job names an engine, optional `inputs`, `params`, a `generateValues` spec, an
optional `raw` directory name, and an optional `bake`. It may also set
`inputFrom` to reuse another job's captured output asset (see stage 3). Jobs
with `enabled: false` are skipped. `--only` selects by id and errors if an id
does not exist.

`generateValues` is resolved offline by `src/values.mjs` and injected as
`params.values` at resolve time. The built-ins are `height` (a seamlessly
tiling height field with `noise`/`ridge`/`cells` variants and the
`freq`/`octaves`/`angle`/`anisotropy` variety knobs), the effect family
`radial`, `portal`, `spark`, `bloom`, `vortex`, `contract`, `rise`, `shield`
and `snow`, and the field generators `dust` (soft drifting accumulations) and
`flow` (directional wear streaks). Every generator is a pure function of its
`{ type, size, seed, frame, … }` spec, returns a square grid of values in
`[0, 1]`, and is covered by determinism, bounds and per-frame-variation tests;
the knobbed `height` field is also pinned byte-for-byte against the pre-knob
formula. The effect grids share the integer-hash noise in `src/noise.mjs`
(including the anisotropic `tileFbmXY` used by `flow`), so a bake is
reproducible on any platform. A module config can add its own generators under
`generators`.

### 3. Resolve (`src/api.mjs`, `src/runner.mjs`)

Resolution is chosen by a frozen dependency/spending plan, in order:

1. **Recorded** — read the declared fixture, no API or key.
2. **Archive rebuild** — verify the generation/recipe/blob hashes and rebuild
   locally. Immutable raw-name conflicts fail before spending.
3. **Journal resume** — attach to a known queued/processing job or retrieve a
   known completed result. Legacy manually attached ids are explicitly
   unverified and cannot cross known recipe provenance.
4. **Live** — only after the exact frozen plan passes local budget policy and
   is supplied as `--approve-spend <fingerprint>`: upload inputs, persist
   `submitting`, POST, persist the returned id, poll and fetch the result.

`submitting` without a confirmed id and `unknown-submission` are manual
reconciliation states and never become a POST. `--force` creates fresh intent
but is not spending approval. Engines prefixed `local:` are blocked from this
runner and must use an explicit local-backend command.

The client is injectable (`fetchImpl`, `sleepImpl`) and is created from
`baseUrl` + key for the duration of a run. `MOTH_API_KEY` is required only when
a selected job may hit the API; `--dry` and recorded-only runs do not need it.

Requests are paced and retried. One client owns a single concurrency-1 gate with
a minimum spacing (`MOTH_MIN_INTERVAL_MS`, default 300 ms), so a run's requests
start one at a time and never faster than the interval. A `429` honours
`Retry-After` (seconds or an HTTP date, capped at two minutes) or backs off
exponentially with jitter (`MOTH_RETRY_BASE_MS` default 1000,
`MOTH_RETRY_CAP_MS` default 30000, `MOTH_MAX_RETRIES` default 5), logging each
wait as `rate limited, retrying in Ns`. Safe GETs retry `429`, transient `5xx`
and network failures. Unsafe job/asset POSTs retry only a definite `429`; an
ambiguous network/5xx outcome fails closed because repeating it could duplicate
work or pending assets. Polling is adaptive:
`MOTH_POLL_INTERVAL_MS` (default 1500 ms), growing 1.5x while the status marker
is unchanged up to `MOTH_POLL_MAX_INTERVAL_MS` (default 5000 ms), reset on any
transition; the 15-minute timeout is unchanged.

Raw outputs are archived under `<out>/raw/<raw>/` as `<slot>.<ext>` (extension
from `content_type`), and an inline `result` is written as
`inline-result.json`. `.mothbake-archive.json` binds every file hash to its
generation identity. The
`raw` name and the `saved` map are passed to bakers, which is how the `ir` baker
can emit a portable relative path.

Each saved output also carries the API's `output_asset_id` (when present). The
runner keeps those ids for the verified run, optionally writes compatibility
metadata back to a JSON config, and records them in bundle provenance as
`<job>.outputs`. A later job can then set `inputFrom: { slot: { job, slot } }`
to reuse an earlier artifact without re-uploading or re-paying. Resolution uses
this run's captured id or a re-upload of that run's freshly hash-verified
archive. Mutable persisted ids never satisfy a dirty dependency edge.

Newly obtained `jobId`s are persisted in the run journal before polling.
Compatibility write-back to JSON configs remains optional. Module configs are
never rewritten.

By default a failed job is collected and the run continues; `strict: true`
(the CLI's `--strict`) rethrows the first failure and aborts before emitting.

### 4. Records (`src/bakers/`)

A baker is `bake(job, ctx) => { bucket, key, value, merge?, index?, fps? }`.
The runner stamps `job` and `type` to make the full record:

```jsonc
{
  "job": "rift-frame",
  "type": "effect-frame",
  "bucket": "effects",
  "key": "rift",
  "merge": "frames",
  "index": 0,
  "fps": 10,
  "value": { "width": 48, "height": 48, "format": "rgba8", "data": "…base64…" }
}
```

Records are JSON-serializable by design: no buffers, no file handles, no
functions. That makes them easy to diff, emit, or push through a custom
pipeline. `value.file` is the one exception in spirit — it is a *relative path*
resolved against the output dir by emitters that need the bytes.

`effect-frame` records name their key with `bake.name` and fall back to
`bake.effect`, then the job id, so an effect can be labelled independently of
the record key.

`sprite-sheet` and the audio bakers follow the same records-are-data rule: the
WAV decoder normalises PCM to float channels and `audio-clip` emits a
self-contained WAV (base64) with trim, gain and loop metadata — or, with
`embed: false`, a `file`/`url` reference to a separately encoded processed WAV
under `processed/audio/`. It never aliases provider raw bytes. `audio-stitch`
concatenates ordered slots with crossfades and `echo-map` reduces a trajectory
envelope to a compact tap map. None bake a consumer-specific shape — the
`atlas`, `files` and `audio-pack` emitters decide how the bytes land on disk.

The built-in bakers are thin wrappers over the decoders:

| Baker | Decoders used |
| --- | --- |
| `texture-tile` | `decodePng`, explicit bilinear/nearest resize, boundary diagnostics |
| `sky` | `decodePng`, `resizeNearest`; requires declared equirectangular source projection |
| `material-lut` | `unzip`, `decodeHdr`, `hdrToRgb8`; retains hashed HDR masters separately from previews |
| `normal-map`, `effect-frame` | `resampleGrid`, `gridToNormal`, `gridToRamp` |
| `raw-grid` | none (copies a validated numeric inline grid without image scaling) |
| `motif` | `decodeMidi` |
| `ir` / `ir-descriptor` | `wavInfo` |
| `sprite-sheet` | `decodeGif` |
| `audio-clip` | `decodeWav`, `encodeWav`, `mixdownChannels` |
| `audio-stitch` | `decodeWav`, `encodeWav`, `mixdownChannels`, `zip` (chunk inputs) |
| `echo-map` | none (recursive JSON tap extraction) |
| `level-graph`, `seed` | none (inline JSON) |

The two audio bakers share `src/bakers/audio.mjs`: explicit preview linear or
production windowed-sinc resampling, category-aware quality reporting, the
deterministic loop-seam finder, the equal-power seam crossfade and the
`embed`/`file`/`url` descriptor builder. `echo-map` and `ir` share the recursive
`tapsFrom()` extractor and the `url`/`urlBase` resolver in
`src/bakers/util.mjs`.

### 5. Bundle (`src/bundle.mjs`)

`bundleRecords()` is the shared aggregate view used by the `json` and `esm`
emitters: `{ version, generator, provenance, <bucket>: { <key>: value } }`,
with effect frames merged into `{ fps, frames: [...] }`. Bucket order is
first-seen, so output is deterministic for a deterministic job list.

The flat record list is still available (`shape: "records"`), which is useful
for consumers that prefer arrays or for per-record transforms.

### 6. Emit (`src/emitters/`)

An emitter is `emit(records, ctx) => string[]` (or a promise of one). `ctx`
carries `outDir`, the resolved `options`, the whole `config`, `provenance`,
`version`, `generator` and a `log`. The registry resolves config entries in
three shapes:

- `"files"` — built-in by name
- `{ "type": "esm", "file": "baked.mjs" }` — built-in with options
- `(records, ctx) => [...]` or `{ name, options, emit }` — custom, from a module
  config

Defaults: with no `emitter`/`emitters`, a single `files` emitter runs. The
`atlas` built-in is a specialised writer: it turns each `sprite-sheet` record
into a PNG plus a JSON sidecar and leaves other record types untouched, so it
composes with `files`/`json`/`esm` in one run. The `audio-pack` built-in is the
audio counterpart: it writes `audio-clip`/`audio-stitch`/`ir` audio and
`echo-map`/`ir` sidecars under `<dir>/<bucket>/` plus a `manifest.json` that
describes every clip (`url`, `seconds`, `sampleRate`, `channels`, `loopStart`,
`loopEnd`, `gain`). Both are deterministic and idempotent.

#### Publication (`src/publish.mjs`)

Every emitter writes through `writeFileAtomic` (same-directory temp file plus
rename), so a crash or a validation error cannot leave a half-written artifact:
the previous file stays byte-identical. Aggregate emitters additionally
validate before writing with `validateForPublish`: exact JSON throughout
(`assertJsonSafe` rejects NaN/Infinity, dropped `undefined` keys, array holes,
cycles and non-plain objects, naming the offending path) and provenance
coverage for every job whose records the artifact carries.

Aggregate emitters accept `merge: true`. They load their previous artifact
(`readJsonArtifact` for JSON, `readModuleArtifact` for the `esm` module; a
missing file is `null`, a corrupt one is an error so it is never silently
replaced) and overlay this run's records with `mergeRecordsIntoBundle`,
`mergeRecordLists`, `mergeBundles` or `mergeIndex`. Keys this run did not write
keep their previous values, and frame records merge by index so a partial
effect run cannot shift a later frame onto index 0. Merge is opt-in per
emitter; a default run replaces its artifact exactly as before. That makes a
scoped `repair` or an `--only` run additive instead of destructive.

Downloaded outputs go through the same gates in `src/api.mjs`: `res.ok` is
enforced, the served `content-type` must match the declared one (parameters and
case ignored), and an empty body is an error rather than an empty artifact.

### 7. Repair (`src/repair.mjs`)

`mothbake repair` is the offline counterpart of a run: it rebuilds every
built-in baker from the raw outputs a previous run archived under
`<out>/raw/<raw>/`, then re-runs the configured emitters — no API key, no
credits. `readRawResults()` maps `<slot>.<ext>` back onto declared slot names
and reads `inline-result.json` as the inline result, so a baker sees exactly the
`{ files, saved, result }` shape a normal resolve produces (including the
relative `file` an `ir`/`audio-clip` descriptor points at).

`LOCAL_BAKE_TYPES` mirrors the built-in baker registry. A job may use `bakes`
to feed one archived result into several local transforms without another
submission. `rebuildLocalBakes()` is pure over the filesystem and collects missing
archives and baker errors as `failures`; `repairConfig()` emits the rebuilt
records. Because it re-runs the emitters over only those records, scope it with
`--only` (or a config of the local jobs) if the aggregate emitters should not
contain just the repaired records.

## Extension points

| Want to… | Do this |
| --- | --- |
| Add an engine job | Add an entry to `jobs` in the config. Nothing is hardcoded per engine. |
| Change bucket/key names | Set `bake.bucket` / `bake.name`; nothing else depends on a fixed vocabulary. |
| Support a new output format | Add a decoder in `src/decoders/` and use it from a baker. |
| Add a baker | Export it from a module config (`bakers: { 'my-type': fn }`). Signatures are documented in `src/bakers/index.mjs`. |
| Add a value generator | `generators: { myGrid: (spec) => grid }` in a module config. |
| Add an emitter | `emitters: [fn]` in a module config; return the paths you wrote. |
| Support another run shape | Compose the exported functions (`loadConfig`, `runConfig`, `bundleRecords`, `runEmitters`) in your own script. |

## Design decisions

- **Zero runtime dependencies.** Decoders are the risky part of any bake step
  (files must be readable years later); owning them keeps the tool auditable and
  installable in air-gapped CI. PNG (filters 0–4, colour types 0/2/3/4/6,
  non-interlaced), GIF87a/89a (LZW, interlace, transparency, disposal, loops),
  ZIP (stored/deflate read and write), Radiance RGBE (flat/modern RLE), WAV
  (8/16/24/32-bit PCM and 32-bit float decode/encode) and MIDI (format 0/1) are
  covered.
- **Records are data, not code.** Emitters decide the final shape; the game
  module shape is just one `esm` config, not a special case in the runner.
- **Recorded fixtures are first-class.** Any job can carry a `recorded` block,
  so CI and examples run the *same* pipeline without network access.
- **No key handling beyond bearer tokens.** The key is read from the
  environment, used per request, and never persisted or logged.
- **Warnings for unknown keys, errors for wrong types.** Config typos are
  surfaced, but custom extension options are not blocked.
- **Failures are per job.** One bad job does not stop a run; the CLI exits 1 at
  the end and prints each failure.
- **Publication is failure-safe.** Emitter writes are atomic and validated as
  exact JSON before they land, and merge is opt-in per emitter. A partial run
  or a validation error can leave a published artifact stale, but never
  half-written or silently truncated.
- **Rate limits are handled, not ignored.** One paced request gate per run;
  GETs retry transient failures freely, a paid submit retries only when a `429`
  proves nothing was created, and polling backs off while a job is stalled.

## Upstream sync

`mothbake` is the portable, de-branded counterpart of a private asset pipeline.
Every generic mechanism in that pipeline — a decoder, baker, source pattern,
value generator, emitter or runner option — is expected to exist here too.
[docs/SYNC.md](SYNC.md) holds the maintenance rule and a capability matrix; the
short version is that a new upstream capability is only complete once it is
ported here with tests, docs and a changelog note.

## Module map

```
bin/mothbake.mjs        thin wrapper -> src/cli.mjs
src/cli.mjs             argument parsing, commands, exit codes
src/config.mjs          load + validate
src/execution-plan.mjs  frozen dependency/spending plan and layered recipe inputs
src/job-graph.mjs       topological inputFrom planning and --only closure
src/run-journal.mjs     durable single-host execution state and locking
src/identity.mjs        canonical SHA-256 identities for each pipeline layer
src/archive.mjs         hash-verified raw result archives
src/runner.mjs          plan/resolve/archive/bake/emit orchestration
src/repair.mjs          offline rebuild of every built-in baker
src/api.mjs             HTTP client (engines, jobs, assets), pacing, retries, polling
src/engine-contracts.mjs sanitized engine snapshots and request validation
src/backends/*         bounded opt-in local backend subprocesses
python/mothbake_backends optional Python shims; never installed by npm
src/candidates.mjs      hash-verified local candidate index
src/approvals.mjs       content-pinned approval and supersession history
src/workbench-server.mjs loopback-only candidate review server
src/variations.mjs      bounded, frozen exploration/refinement plans
src/transactional-pack.mjs versioned pack promotion and rollback
src/gc.mjs             read-only evidence/reference/hash reporting
src/media-structure.mjs bounded container checks for non-decoded media
src/bundle.mjs          records -> aggregate bundle
src/values.mjs          generateValues grids
src/noise.mjs           deterministic value noise
src/sources.mjs         procedural source art + audio seeds/chunks
src/image.mjs           pixel/grid helpers, ramps, base64
src/decoders/{png,gif,zip,hdr,wav,midi}.mjs
src/bakers/*.mjs        one file per baker + registry (+ shared audio helpers)
src/emitters/*.mjs      files, json, esm, atlas, audio-pack + registry
src/publish.mjs         atomic writes, exact-JSON validation, merge-safe publication
```

## Tests

Everything runs under `node --test` and makes no external network calls:

| Area | File |
| --- | --- |
| Decoders, against recorded fixtures | `test/decoders.test.mjs` |
| GIF decoding (interlace, transparency, disposal, errors) | `test/gif.test.mjs` |
| Sprite-sheet/audio-clip bakers + atlas emitter | `test/media.test.mjs` |
| Audio pipeline: extended `audio-clip`, `audio-stitch`, `echo-map`, `audio-pack`, source audio/chunks | `test/audio.test.mjs` |
| Bakers, against recorded fixtures | `test/bakers.test.mjs` |
| Values and noise determinism | `test/values.test.mjs` |
| Source art and motif round-trips | `test/sources.test.mjs` |
| Config loading and validation messages | `test/config.test.mjs` |
| CLI help, validate, `--dry`, sources, offline run | `test/cli.test.mjs` |
| Submit → poll → download → bake → emit against a mock API; cached-job reuse and the failed/unknown-status guard | `test/mock-server.test.mjs` |
| Offline repair from raw outputs (`repair`, `LOCAL_BAKE_TYPES`) | `test/repair.test.mjs` |
| Emitters (files/json/esm, custom) | `test/emitters.test.mjs` |
| Publication: atomic writes, exact-JSON validation, merge-safe emitters, download validation | `test/publish.test.mjs` |
| Pacing, retries, credit-safe submits and adaptive polling (virtual time and a rate-limited mock server) | `test/rate-limit.test.mjs` |
| ESM emitter byte-for-byte golden | `test/golden.test.mjs` + `test/golden/baked.golden.mjs` |
| Runner helpers (selection, dry plans, write-back) | `test/runner.test.mjs` |

Regenerate the golden module with
`UPDATE_GOLDEN=1 node --test test/golden.test.mjs`.
