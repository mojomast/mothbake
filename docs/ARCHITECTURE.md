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
optional `raw` directory name, and an optional `bake`. Jobs with `enabled:
false` are skipped. `--only` selects by id and errors if an id does not exist.

### 3. Resolve (`src/api.mjs`, `src/runner.mjs`)

Resolution has three paths, in order:

1. **Recorded** (`job.recorded`, skipped by `--force`) — read local files, no
   API, no key.
2. **Cached** (`job.jobId`, skipped by `--force`) — check the job status; if it
   is `completed`, fetch the result.
3. **Live** — upload inputs (`create asset` → presigned `PUT` → `complete`),
   inject `params.values` from `generateValues`, `POST …/process`, poll
   `…/status`, fetch `…/result`.

The client is injectable (`fetchImpl`, `sleepImpl`) and is created from
`baseUrl` + key for the duration of a run. `MOTH_API_KEY` is required only when
a selected job may hit the API; `--dry` and recorded-only runs do not need it.

Raw outputs are archived under `<out>/raw/<raw>/` as `<slot>.<ext>` (extension
from `content_type`), and an inline `result` is written as `result.json`. The
`raw` name and the `saved` map are passed to bakers, which is how the `ir` baker
can emit a portable relative path.

Newly obtained `jobId`s are written back to JSON configs only when they change
and when `writeBack !== false`. Module configs are never rewritten; the runner
logs the ids instead (they are in the bundle's provenance either way).

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

The built-in bakers are thin wrappers over the decoders:

| Baker | Decoders used |
| --- | --- |
| `texture-tile`, `sky` | `decodePng`, `resizeNearest` |
| `material-lut` | `unzip`, `decodeHdr`, `hdrToRgb8` |
| `normal-map`, `effect-frame` | `resampleGrid`, `gridToNormal`, `gridToRamp` |
| `motif` | `decodeMidi` |
| `ir` / `ir-descriptor` | `wavInfo` |
| `level-graph`, `seed` | none (inline JSON) |

### 5. Bundle (`src/bundle.mjs`)

`bundleRecords()` is the shared aggregate view used by the `json` and `esm`
emitters: `{ version, generator, provenance, <bucket>: { <key>: value } }`,
with effect frames merged into `{ fps, frames: [...] }`. Bucket order is
first-seen, so output is deterministic for a deterministic job list.

The flat record list is still available (`shape: "records"`), which is useful
for consumers that prefer arrays or for per-record transforms.

### 6. Emit (`src/emitters/`)

An emitter is `emit(records, ctx) => string[]`. `ctx` carries `outDir`, the
resolved `options`, the whole `config`, `provenance`, `version`, `generator` and
a `log`. The registry resolves config entries in three shapes:

- `"files"` — built-in by name
- `{ "type": "esm", "file": "baked.mjs" }` — built-in with options
- `(records, ctx) => [...]` or `{ name, options, emit }` — custom, from a module
  config

Defaults: with no `emitter`/`emitters`, a single `files` emitter runs.

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
  non-interlaced), ZIP (stored/deflate), Radiance RGBE (flat/modern RLE), WAV
  (metadata only) and MIDI (format 0/1) are covered.
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

## Module map

```
bin/mothbake.mjs        thin wrapper -> src/cli.mjs
src/cli.mjs             argument parsing, commands, exit codes
src/config.mjs          load + validate
src/runner.mjs          resolve/archive/bake/emit orchestration
src/api.mjs             HTTP client (engines, jobs, assets)
src/bundle.mjs          records -> aggregate bundle
src/values.mjs          generateValues grids
src/noise.mjs           deterministic value noise
src/sources.mjs         procedural source-art generator
src/image.mjs           pixel/grid helpers, ramps, base64
src/decoders/{png,zip,hdr,wav,midi}.mjs
src/bakers/*.mjs        one file per baker + registry
src/emitters/*.mjs      files, json, esm + registry
```

## Tests

Everything runs under `node --test` and makes no external network calls:

| Area | File |
| --- | --- |
| Decoders, against recorded fixtures | `test/decoders.test.mjs` |
| Bakers, against recorded fixtures | `test/bakers.test.mjs` |
| Values and noise determinism | `test/values.test.mjs` |
| Source art and motif round-trips | `test/sources.test.mjs` |
| Config loading and validation messages | `test/config.test.mjs` |
| CLI help, validate, `--dry`, sources, offline run | `test/cli.test.mjs` |
| Submit → poll → download → bake → emit against a mock API | `test/mock-server.test.mjs` |
| Emitters (files/json/esm, custom) | `test/emitters.test.mjs` |
| ESM emitter byte-for-byte golden | `test/golden.test.mjs` + `test/golden/baked.golden.mjs` |
| Runner helpers (selection, dry plans, write-back) | `test/runner.test.mjs` |

Regenerate the golden module with
`UPDATE_GOLDEN=1 node --test test/golden.test.mjs`.
