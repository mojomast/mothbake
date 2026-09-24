# Architecture

`mothbake` is a small pipeline with four contracts: **jobs**, **results**,
**records**, and **emitters**. Everything between them is a pure function, which
is why the whole thing tests offline.

```
config ─▶ jobs ─▶ [resolve] ─▶ raw outputs ─▶ [decode] ─▶ [bake] ─▶ records ─▶ [emit] ─▶ artifacts
             │                                                                             ▲
             └──────────────────────── provenance ─────────────────────────────────────────┘
```

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

Resolution has three paths, in order:

1. **Recorded** (`job.recorded`, skipped by `--force`) — read local files, no
   API, no key.
2. **Cached** (`job.jobId`, skipped by `--force`) — check the job status; if it
   is `completed`, fetch the result. Any other outcome — `failed`, `cancelled`,
   still running, an unrecognized status, or a status request that errors — does
   **not** fall through to a fresh submission: it fails the job with a message
   that names `--force`, because an automatic resubmission would spend credits
   when the user only meant to reuse a result.
3. **Live** — upload inputs (`create asset` → presigned `PUT` → `complete`),
   inject `params.values` from `generateValues`, `POST …/process`, poll
   `…/status`, fetch `…/result`.

The client is injectable (`fetchImpl`, `sleepImpl`) and is created from
`baseUrl` + key for the duration of a run. `MOTH_API_KEY` is required only when
a selected job may hit the API; `--dry` and recorded-only runs do not need it.

Requests are paced and retried. One client owns a single concurrency-1 gate with
a minimum spacing (`MOTH_MIN_INTERVAL_MS`, default 300 ms), so a run's requests
start one at a time and never faster than the interval. A `429` honours
`Retry-After` (seconds or an HTTP date, capped at two minutes) or backs off
exponentially with jitter (`MOTH_RETRY_BASE_MS` default 1000,
`MOTH_RETRY_CAP_MS` default 30000, `MOTH_MAX_RETRIES` default 5), logging each
wait as `rate limited, retrying in Ns`. GETs and non-submit POSTs retry `429`,
transient `5xx` and network failures; a job submit retries only `429` — after a
network error or `5xx` it fails closed with a "may or may not have been created"
message, because a retry could pay for a second job. Polling is adaptive:
`MOTH_POLL_INTERVAL_MS` (default 1500 ms), growing 1.5x while the status marker
is unchanged up to `MOTH_POLL_MAX_INTERVAL_MS` (default 5000 ms), reset on any
transition; the 15-minute timeout is unchanged.

Raw outputs are archived under `<out>/raw/<raw>/` as `<slot>.<ext>` (extension
from `content_type`), and an inline `result` is written as `result.json`. The
`raw` name and the `saved` map are passed to bakers, which is how the `ir` baker
can emit a portable relative path.

Each saved output also carries the API's `output_asset_id` (when present). The
runner keeps those ids for the duration of a run and, for a JSON config, writes
them back as `job.assetIds`, and records them in the bundle provenance as
`<job>.outputs`. A later job can then set `inputFrom: { slot: { job, slot } }`
to reuse an earlier artifact without re-uploading or re-paying. Resolution order
is: this run's captured id → the persisted `assetIds` → a re-upload of the
archived raw output → an error.

Newly obtained `jobId`s are written back to JSON configs only when they change
and when `writeBack !== false`. Module configs are never rewritten; the runner
logs the ids instead (they are in the bundle's provenance either way).

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
`embed: false`, a `file`/`url` reference for large clips. `audio-stitch`
concatenates ordered slots with crossfades and `echo-map` reduces a trajectory
envelope to a compact tap map. None bake a consumer-specific shape — the
`atlas`, `files` and `audio-pack` emitters decide how the bytes land on disk.

The built-in bakers are thin wrappers over the decoders:

| Baker | Decoders used |
| --- | --- |
| `texture-tile`, `sky` | `decodePng`, `resizeNearest` |
| `material-lut` | `unzip`, `decodeHdr`, `hdrToRgb8` |
| `normal-map`, `effect-frame` | `resampleGrid`, `gridToNormal`, `gridToRamp` |
| `motif` | `decodeMidi` |
| `ir` / `ir-descriptor` | `wavInfo` |
| `sprite-sheet` | `decodeGif` |
| `audio-clip` | `decodeWav`, `encodeWav`, `mixdownChannels` |
| `audio-stitch` | `decodeWav`, `encodeWav`, `mixdownChannels`, `zip` (chunk inputs) |
| `echo-map` | none (recursive JSON tap extraction) |
| `level-graph`, `seed` | none (inline JSON) |

The two audio bakers share `src/bakers/audio.mjs`: linear resampling, the
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

`mothbake repair` is the offline counterpart of a run: it rebuilds the purely
local, file-derived records from the raw outputs a previous run archived under
`<out>/raw/<raw>/`, then re-runs the configured emitters — no API key, no
credits. `readRawResults()` maps `<slot>.<ext>` back onto declared slot names
and reads `result.json` as the inline result, so a baker sees exactly the
`{ files, saved, result }` shape a normal resolve produces (including the
relative `file` an `ir`/`audio-clip` descriptor points at).

`LOCAL_BAKE_TYPES` (`ir`/`ir-descriptor`, `echo-map`, `audio-clip`,
`audio-stitch`) is the set whose inputs are entirely local. It is the portable
counterpart of the upstream repair path and deliberately includes the
file-derived `audio-clip` (`embed: false`), which writes a WAV beside its
descriptor, so a baker fix can be re-applied without re-paying for the engine
run. `rebuildLocalBakes()` is pure over the filesystem and collects missing
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
src/runner.mjs          resolve/archive/bake/emit orchestration
src/repair.mjs          offline rebuild of local records from raw outputs
src/api.mjs             HTTP client (engines, jobs, assets), pacing, retries, polling
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
