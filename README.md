# mothbake

[![CI](https://github.com/mojomast/mothbake/actions/workflows/ci.yml/badge.svg)](https://github.com/mojomast/mothbake/actions/workflows/ci.yml)

**Manifest-driven asset baking with zero runtime dependencies.**

`mothbake` runs a list of jobs against an asset-generation API, decodes every
result itself (PNG, GIF, ZIP, Radiance HDR, WAV, MIDI), reduces each result to a
small portable record, and emits whatever your project consumes: decoded files,
sprite-sheet atlases, one JSON bundle, a generated ES module, or a custom
emitter you write in a few lines.

It is built for pipelines where baked data must be deterministic, committed to
the repository, and readable at runtime without a browser decoder, a build step,
or an npm dependency tree — game textures, skyboxes, normal maps, animation
frames, sprite sheets, material LUTs, impulse responses, audio clips, motifs and
seeds.

## Gallery

<!-- GALLERY:START -->

The sheets below come from recorded bakes; no network or API key is involved.
They are regenerated with [`scripts/gallery.py`](scripts/gallery.py).

| Albedo tiles | Normal maps |
| --- | --- |
| ![Eighteen tiling albedo textures](docs/images/gallery-textures.png) | ![Thirteen tangent-space normal maps](docs/images/gallery-normals.png) |
| Eighteen seamless `texture-tile` bakes, downscaled from 256 px. | Thirteen `normal-map` records derived from blurred height grids (strength 4 for legibility). |

| Skies | Effect frames |
| --- | --- |
| ![Three baked skies](docs/images/gallery-skies.png) | ![Effect frames](docs/images/gallery-effects.png) |
| Three 512×256 equirectangular `sky` bakes: ashen, frost and void. | `effect-frame` records from radial, portal and spark grids through the `quantum`, `plasma` and `ember` ramps. |

| Material LUTs | Motifs |
| --- | --- |
| ![Material LUT lobes](docs/images/gallery-luts.png) | ![Motif piano rolls](docs/images/gallery-motifs.png) |
| Reflectance (R) and transmittance (T) lobes from three `material-lut` packs, normalised per lobe for display. | Piano rolls from two `motif` bakes — `step` and `dur` are in sixteenth notes at 60 bpm. |

**Impulse response.** A 4-second `ir` bake: peak envelope in dB with tap times
marked, plus the tap map from the descriptor (level vs. time, radius by depth).

![Impulse response bake](docs/images/gallery-ir.png)

**In a real-time scene.** Baked albedos, normal maps and a baked sky, rendered
by a compatibility renderer.

![Baked assets in a real-time scene](docs/images/in-engine.jpg)

<!-- GALLERY:END -->

## Features

- **Zero runtime dependencies.** Every decoder is in this repository — PNG
  (filters 0–4, colour types 0/2/3/4/6), GIF87a/89a (LZW, interlace,
  transparency, disposal, loops), ZIP (stored/deflate read *and* write),
  Radiance RGBE (flat and modern RLE), WAV (PCM 8/16/24/32-bit and 32-bit float
  decode + encode) and Standard MIDI (format 0/1). Auditable and installable in
  air-gapped CI.
- **Config is data or code.** A `mothbake.json` manifest, or a
  `mothbake.config.mjs` module when you want custom bakers, emitters or value
  generators.
- **Portable records.** A baker turns a finished job into a JSON-serializable
  `{ bucket, key, value }` fragment. Records diff, cache and ship well; emitters
  decide the final shape.
- **Offline-first.** Any job can carry a `recorded` block, so examples and tests
  run the *same* pipeline with no key and no network.
- **Failures are per job.** One bad job is reported and the rest still run; the
  command exits `1` at the end. Add `--strict` to stop at the first failure.
- **Offline repair.** `mothbake repair` rebuilds the purely local, file-derived
  records (`ir`, `echo-map`, `audio-clip`, `audio-stitch`) from the raw outputs a
  run already archived, then re-runs the emitters — no API key and no credits,
  so a baker fix can be re-applied to a committed bake.
- **Merge-safe publication.** Aggregate emitters can opt into `merge: true`, so
  a partial run (`--only`, disabled jobs, or a failed job) overlays this run's
  records on the previous artifact instead of dropping everything it did not
  just bake. Writes are atomic (same-directory temp + rename) and validated as
  exact JSON first: NaN, `undefined`, array holes, cycles and non-plain objects
  are rejected with the offending path, and a rejected write leaves the
  previous artifact byte-identical.
- **Provenance by default.** Bundles carry `engine`, `jobId`, `mode` and
  `credits` per job, and successful live submissions write their `jobId` back so
  the next run downloads instead of paying again. A recorded job that is not
  `completed` is never silently resubmitted: the run fails and names `--force`.
  Captured `output_asset_id`s are persisted too, and a later job can reuse one
  with `inputFrom`.
- **Deterministic output.** Bucket order is first-seen and the ESM emitter is
  covered by a byte-for-byte golden test.

## Requirements

| | |
| --- | --- |
| Node.js | 20 or newer (ESM) |
| Dependencies | none, at runtime or install time |
| API key | `MOTH_API_KEY`, only for `catalog` and for `run` when a selected job is not recorded |

## Install

```bash
git clone https://github.com/mojomast/mothbake.git
cd mothbake
node bin/mothbake.mjs --help
```

That is the whole install — there is nothing to build and nothing to fetch.

Optionally put the command on your `PATH`:

```bash
npm link          # then: mothbake --help
```

## Quick start

```bash
# 1. Describe what to bake.
cat > mothbake.json <<'JSON'
{
  "jobs": [
    {
      "id": "rock-tile",
      "engine": "blur-v1",
      "inputs": { "image": "sources/rock.png" },
      "params": { "strength": 0.32, "style": "ry", "size": 256 },
      "raw": "rock-tile",
      "bake": { "type": "texture-tile", "name": "rock", "size": 64 }
    }
  ],
  "emitter": { "type": "esm", "file": "baked.mjs", "export": "BAKED" }
}
JSON

# 2. Check the manifest, then see what a run would do.
node bin/mothbake.mjs validate
node bin/mothbake.mjs run --dry

# 3. Render local source art (free, offline), then bake for real.
node bin/mothbake.mjs sources
MOTH_API_KEY=... node bin/mothbake.mjs run
```

Every artifact is written under `mothbake-out/` (change it with `--out`):
decoded files per bucket, `raw/` archives of the engine results, `index.json`,
and the `baked.mjs` module the config asked for.

A complete offline example — texture, sky, normal map, nine effect frames
(radial, portal, spark, bloom, vortex, contract, rise, shield and snow
generators), LUT, motif, two impulse responses (including an open-air room), an
animated GIF sprite sheet, embedded and file-mode audio clips, a stitched clip,
an echo map, generated audio seeds/chunks and an `audio-pack` bundle — lives in
[`examples/manifest.json`](examples/manifest.json):

```bash
node bin/mothbake.mjs run --config examples/manifest.json --out out/examples
```

## CLI reference

```
mothbake <command> [options]

Commands:
  catalog     List the engines the API exposes and their credit cost
  validate    Validate the config and report every problem
  sources     Generate procedural source art (PNG/MIDI) locally
  run         Resolve jobs, bake records, and run the emitters
  repair      Rebuild local records from raw outputs, without the API

Options:
  -c, --config <file>  Config file (default: mothbake.config.mjs / .js / mothbake.json)
  -o, --out <dir>      Output directory (default: mothbake-out; sources default: sources)
      --only <id>      Only this job (repeatable or comma-separated); with sources: pattern names
      --force          Ignore recorded fixtures and cached job ids; submit fresh jobs
      --dry            Print what would run without touching the API or writing files
      --strict         Stop at the first failed job instead of continuing
      --base <url>     Override the API base URL
  -h, --help           Show help
  -v, --version        Show the version
```

`run` exits non-zero if any job fails. `validate` exits non-zero if the config
has errors (warnings are printed but do not fail the run). `repair` exits
non-zero if a selected local job has no raw archive or cannot be rebuilt.

### Environment

| Variable | Meaning |
| --- | --- |
| `MOTH_API_KEY` | Bearer token. Required for `catalog`, and for `run` when any selected job is not recorded. Never written to disk. |
| `MOTH_API_BASE` | API base URL. Default `https://api.mothquantum.com`. Overridden by `--base` and overrides `baseUrl` from the config. |

### What a run does

1. **Plan** — load and validate the config, select jobs (`--only`, `enabled`).
2. **Resolve** — use a `recorded` fixture, reuse a cached `completed` `jobId`,
   or submit a live job (uploading inputs, resolving `inputFrom` assets,
   injecting generated values, polling to completion).
3. **Archive** — save raw outputs under `<out>/raw/<raw>/`, plus `result.json`
   for inline JSON results.
4. **Bake** — run the job's baker over the raw outputs and inline result to
   produce a portable record.
5. **Emit** — hand all records to the configured emitters. Every artifact is
   written atomically and aggregates are validated as exact JSON first. With
   `merge: true` an aggregate emitter overlays this run's records on its
   previous artifact, so a partial run never drops published data.

A failed job is reported and the remaining jobs still run; the command exits 1
at the end. Pass `--strict` (or `strict: true` to `runConfig`) to stop at the
first failure instead. Successful live submissions record their `jobId` back
into a JSON config, so re-running downloads the existing result instead of
paying for another run. Add `--force` to submit fresh jobs anyway.

A cached `jobId` is only reused when the API confirms that job is `completed`.
If it is failed, cancelled, still running, unknown, or its status cannot be
verified, the run **fails** with a message naming `--force` instead of quietly
submitting a new job — a re-download or offline re-run must never spend credits
by accident.

### Offline repair

`mothbake repair` rebuilds the purely local, file-derived records from the raw
outputs already archived under `<out>/raw/<raw>/`, then re-runs the configured
emitters. No API key, no network and no credits:

```bash
node bin/mothbake.mjs run --config examples/manifest.json --out out/examples
# delete the emitted artifacts, keep out/examples/raw, then:
node bin/mothbake.mjs repair --config examples/manifest.json --out out/examples
node bin/mothbake.mjs repair --config examples/manifest.json --out out/examples --only bed-clip
```

The local set is `ir`/`ir-descriptor`, `echo-map`, `audio-clip` and
`audio-stitch`. It includes `audio-clip` with `embed: false` (a WAV written
beside its descriptor), so a file-derived clip is rebuildable exactly like an
`ir` or `echo-map`. `repair` emits only the rebuilt records; scope it with
`--only`, or a config of those jobs, if an aggregate emitter should not be
rewritten with just the repaired records — or set `merge: true` on those
emitters and a scoped repair keeps every record outside the scope too.

## Configuration

A config is a JSON file or an ES module. Default filenames, in priority order:
`mothbake.config.mjs`, `mothbake.config.js`, `mothbake.json` (override with
`--config`).

```jsonc
{
  "version": 1,                     // optional; stamped into bundles
  "generator": "mothbake",          // optional; stamped into bundles
  "baseUrl": "https://api.mothquantum.com", // optional; env/flags win
  "jobs": [ /* required */ ],
  "sources": { /* optional; for `mothbake sources` */ },
  "emitter": { "type": "files" },   // optional; default { type: "files" }
  "emitters": [ /* optional; use instead of emitter for several */ ],
  "writeBack": true                 // optional; record jobIds into JSON configs
}
```

Relative paths in `inputs` and `recorded` are resolved against the config file's
directory. `sources.dir` is too; `--out` is resolved against the working
directory.

### Jobs

```jsonc
{
  "id": "rock-tile",              // required, unique
  "engine": "blur-v1",            // required; the API engine id
  "enabled": true,                // optional; false skips the job
  "jobId": "…",                   // optional; cached result, reused if completed
  "credits": 1,                   // optional metadata for provenance
  "inputs": { "image": "sources/rock.png" }, // optional; slot -> local file
  "params": { "strength": 0.32 }, // optional; passed to the engine
  "generateValues": { "type": "height", "size": 64, "seed": 11 }, // optional
  "raw": "rock-tile",             // optional; raw output dir name (default id)
  "bake": {                       // optional; omit to only archive the raw output
    "type": "texture-tile",       // required baker type
    "name": "rock",               // record key (default: the job id)
    "bucket": "textures",         // record bucket (default: the baker's default)
    "size": 64                    // baker-specific options
  },
  "recorded": {                   // optional; run fully offline from files
    "outputs": { "result": "../fixtures/tile.png" },
    "result": "../fixtures/grid.json"   // or an inline JSON value
  }
}
```

`input` is accepted as an alias of `inputs` (with a warning if both appear).

### Recorded results

A `recorded` block replaces the API round trip: `outputs` maps output slots to
local files, and `result` is the inline JSON result (a file path or an inline
value). This is how the test suite and the examples run without a key, and how
you can commit known-good results and re-bake them deterministically.

### Sources and value generators

`sources` configures the procedural source-art generator used by
`mothbake sources` (see [examples/sources.mjs](examples/sources.mjs)):

```jsonc
{
  "sources": {
    "dir": "sources",             // output dir, relative to the config
    "patterns": {                 // pattern name -> spec (merged over built-ins)
      "rock": { "size": 256, "palette": [0.5, 0.46, 0.4], "pattern": "noise", "contrast": 0.7 },
      "nebula": { "size": 256, "wide": 2, "pattern": "stars", "starDensity": 0.997 }
    },
    "audio": {                    // name -> deterministic mono seed WAV spec
      "bed-seed": { "kind": "drone", "seconds": 8, "sampleRate": 22050, "seed": 7 }
    },
    "chunks": {                   // optional ZIP of fixed-length WAV chunks
      "from": "bed-seed", "file": "bed-chunks.zip", "chunkSeconds": 1
    },
    "only": ["rock"],             // optional restriction
    "motif": { "ppq": 480, "bpm": 60 } // optional; false disables the MIDI file
  }
}
```

Patterns: `noise` (seamless natural material), `panels`, `rivets`, `circuit`,
`stripes`, `corrugated`, `grating`, `diamond`, `weave`, `mesh`, `stars`.
Shared knobs: `size`, `wide`, `palette`, `contrast`, `freq`, `seed`, plus the
pattern-specific `panels`, `ribs`, `cells`, `cloudFreq`, `starDensity`.

`sources.audio` renders deterministic, original mono seed WAVs for audio engines
(`makeSourceAudio`): `kind` is `drone` (a slow evolving drone with soft pulses),
`noise` (a smoothed noise bed) or `pulse`, plus `seconds`, `sampleRate`, `seed`,
`sampleFormat`, `fadeSeconds` and kind-specific knobs. `sources.chunks` splits
one of those seeds into fixed-length WAV chunks and ZIPs them (`makeChunkZip`)
with the dependency-free `zip()`, for engines that take a chunk vocabulary.
`mothbake sources` writes only the audio/chunk files a job actually references.

`generateValues` synthesizes the grid some engines consume without shipping one
in the config. Built-ins:

| `generateValues.type` | Produces | Options |
| --- | --- | --- |
| `height` | seamlessly tiling height field | `size`, `seed`, `kind` (`noise` \| `ridge` \| `cells`) |
| `radial` | expanding shock ring | `size`, `seed`, `frame` |
| `portal` | ring with spokes and a hot core | `size`, `seed`, `frame` |
| `spark` | bright core with needle rays | `size`, `seed`, `frame` |
| `bloom` | explosion core inside an expanding shock ring | `size`, `seed`, `frame` |
| `vortex` | swirling ring of arms around a bright core | `size`, `seed`, `frame` |
| `contract` | contracting capture ring with radial ticks | `size`, `seed`, `frame` |
| `rise` | motes rising through a soft heal column | `size`, `seed`, `frame` |
| `shield` | expanding hexagonal bubble shell with seams | `size`, `seed`, `frame` |
| `snow` | drifting flakes, seamless across frames | `size`, `seed`, `frame` |

Every generator is pure and deterministic, returns a square `size`×`size` grid
of values in `[0, 1]`, and for the animated families accepts a `frame` index.
`height` also accepts `kind` (`noise` | `ridge` | `cells`); the effect families
use a fixed per-type `seed` default when one is not given.

Only `sources` writes files the jobs actually reference; the filter is the set
of `inputs` basenames across all jobs (patterns, audio seeds, chunk archives,
plus `motif.mid`).

## Decoders

Every decoder is dependency-free and importable from `mothbake/decoders` or the
`mothbake/decoders/<name>` subpath (for example `mothbake/decoders/gif`).

| Format | Direction | Notes |
| --- | --- | --- |
| PNG (8-bit, non-interlaced) | decode + encode | Filters 0–4; colour types 0/2/3/4/6. Encoding is RGB or RGBA. |
| GIF87a/89a | decode | Global and local colour tables, LZW, interlacing, transparency, disposal methods 0–3 and the NETSCAPE loop count. Frames are composited onto a transparent logical-screen canvas, so every frame is full-size RGBA. |
| ZIP | read + write | Stored and deflate. `zip()` writes a deterministic classic archive (fixed DOS timestamp); ZIP64 is rejected with a clear error. |
| Radiance RGBE `.hdr` | decode | Flat and modern RLE. |
| WAV | inspect + decode + encode | 8/16/24/32-bit PCM and 32-bit float, up to 8 channels (more is a clear error, mixdown available). A-law, µ-law, ADPCM, 64-bit float and odd bit depths are rejected. |
| Standard MIDI | read + write | Format 0/1, running status, track chunks, SMPTE guard. |

`decodeWav(buffer, { mixdown })` returns normalized `channelData` (`Float32Array`
per channel) plus `samples` when `mixdown: true`; `encodeWav()` writes canonical
little-endian WAV back. `decodeGif(buffer)` returns `{ width, height, version,
background, loops, frames }` with `delay` in seconds. `unzip()`/`zip()` read and
write archives for engine input bundles.

## Bakers

A baker is a pure function that turns a finished job into a **portable record**
— a JSON-serializable `{ bucket, key, value }` fragment. `ctx` gives it the
decoded output slots, the inline result, the job, and the bake options.

| `bake.type` | Reads | `value` payload | Options |
| --- | --- | --- | --- |
| `texture-tile` | PNG | `{ width, height, format: 'rgba8', data }` (base64) | `slot`, `name`, `bucket`, `size` |
| `sky` | PNG | same, plus `equirect: true` | `slot`, `name`, `bucket`, `width`, `height` |
| `material-lut` | ZIP | `{ size, format: 'rgb8', r, t }` (base64) | `slot`, `name`, `bucket`, `size`, `reflectance`, `transmittance` |
| `normal-map` | grid result | RGBA tangent-space normals (base64) | `name`, `bucket`, `size`, `strength` |
| `effect-frame` | grid result | one RGBA frame; same `bucket`+`key` merges into `{ fps, frames }` | `name`, `effect`, `bucket`, `size`, `index`, `fps`, `tint`, `ramp`, `ramps` |
| `level-graph` | inline JSON | `{ name, rows, cols, numQubits, coupling, cells, measurements, metrics }` | `name`, `bucket`, `maxMeasurements` |
| `motif` | MIDI | `{ bpm, ppq, notes: [{ step, midi, dur, vel }] }` (steps in sixteenths) | `slot`, `name`, `bucket`, `maxNotes`, `transpose` |
| `ir` (alias `ir-descriptor`) | WAV (+ taps JSON) | `{ file, url, seconds, sampleRate, channels, format, taps }` | `slot`, `tapsSlot`, `name`, `bucket`, `maxTaps`, `url`, `urlBase` |
| `seed` | inline JSON | `{ seed, hex, bytes, bell, commitment, certificate, … }` | `name`, `bucket`, `hexChars` |
| `sprite-sheet` | GIF | `{ sheet: { width, height, format: 'rgba8', data }, frames: [{ index, x, y, w, h, delay, delayCs, duplicate }], loops, fps?, source }` | `slot`, `name`, `bucket`, `maxWidth`, `powerOfTwo`, `dedupe` |
| `audio-clip` | WAV | `{ container: 'wav', format, sampleFormat, sampleRate, channels, frames, seconds, data \| file, url?, loopStart, loopEnd, gain, peak, trimStart, trimEnd, targetSampleRate?, crossfade?, loopScore?, meta?, source }` | `slot`, `name`, `bucket`, `trim`, `threshold`, `pad`, `trimStart`, `trimEnd`, `normalize`, `peak`, `sampleFormat`, `loopStart`, `loopEnd`, `mixdown`, `maxChannels`, `embed`, `url`, `urlBase`, `file`, `detectLoop`, `loopSearch`, `loopWindow`, `loopThreshold`, `loopCrossfade`, `targetSampleRate`, `maxSeconds`, `meta` |
| `audio-stitch` | WAV slots | same as `audio-clip`, with `source: { crossfadeMs, clips: [{ slot, gain, sampleRate, frames }] }` | `slots` (alias `order`), `gains`, `crossfadeMs`, plus `mixdown`, `maxChannels`, `targetSampleRate`, `maxSeconds`, `sampleFormat`, `normalize`, `peak`, `loopStart`, `loopEnd`, `detectLoop`, `loopCrossfade`, `embed`, `url`, `urlBase`, `meta`, `name`, `bucket` |
| `echo-map` | trajectory/media JSON | `{ lattice, sites, depth, seed, count, taps: [{ site, depth, level, polarity, fRe, fIm, x?, y?, z?, timeMs? }], irFile, irUrl, meta? }` | `slot`, `tapsSlot`, `irSlot`, `maxTaps`, `includeZ`, `name`, `bucket`, `url`, `urlBase`, `meta` |

Notes:

- Image records carry base64 bytes plus `format` (`rgba8` and `rgb8` are the
  current formats), so emitters and consumers never have to guess.
- `effect-frame` records with the same `bucket` and `key` merge by `index`; the
  last `fps` wins and gaps are removed. The key falls back to `bake.effect` when
  `bake.name` is absent, so an effect can be named independently of the record.
- `ir.file` is relative to the output dir. `url` is only populated when the bake
  config sets `url` (with `{raw}`, `{slot}`, `{file}` placeholders) or `urlBase`
  (e.g. `"/audio/ir"` → `/audio/ir/<raw>/result.wav`).
- Grid-based bakers accept the inline result, a `{ result: … }` response, or a
  `{ output: … }` value, so the same config works for live and recorded runs.
- `sprite-sheet` packs the composited GIF frames left-to-right, wrapping to a
  new row at `maxWidth` (default 2048). The sheet is trimmed to the used area
  unless `powerOfTwo` pads both axes. Consecutive identical frames are not given
  a new rectangle: with `dedupe` (default true) the duplicate keeps its own
  `delay` and reuses the previous rectangle, so playback timing is unchanged;
  set `dedupe: false` to give every frame its own rectangle.
- `audio-clip` trims leading/trailing silence below `threshold` (default 0.001)
  and restores `pad` seconds (default 0) on each side; `trimStart`/`trimEnd`
  (seconds) override auto-detection and `trim: false` disables it. The clip is
  peak-normalised to `peak` (default 1) unless `normalize: false`, and the
  applied `gain` plus the pre-normalisation `peak` are recorded. `loopStart` and
  `loopEnd` are seconds measured from the start of the final clip.
- Set `embed: false` on `audio-clip`/`audio-stitch` to emit `file` (the raw
  output's relative path) and `url` (from `url` with `{raw}`/`{slot}`/`{file}`
  placeholders, or `urlBase`) instead of base64 — the same convention as `ir`,
  for beds and other large clips.
- `detectLoop: true` finds a loop seam by comparing the head with candidate
  windows near the tail using an amplitude-aware normalized difference. It
  accepts the longest candidate at or above `loopThreshold` (default 0.5);
  `loopSearch` and `loopWindow` are seconds. Explicit `loopStart`/`loopEnd`
  still win, and the detected `loopScore` is recorded. `loopCrossfade` (seconds)
  equal-power blends the tail into the head at the seam so the wrap is
  continuous.
- `targetSampleRate` linear-resamples (a documented approximation, no anti-alias
  filter) and `maxSeconds` trims to keep beds small. `meta` is copied into the
  record verbatim, so routing hints (`bus`, `kind`, `tags`) are baked rather
  than hard-coded.
- `audio-stitch` concatenates ordered WAV slots (`slots`/`order`, entries are a
  slot name or `{ slot, gain }`); `gains` supplies a parallel gain array and
  `crossfadeMs` equal-power joins each pair. Output is an `audio-clip`-shaped
  record, so `files` and `audio-pack` already understand it.
- `echo-map` reduces a trajectory/media envelope to a compact tap map, searching
  `extras.taps`, `extras.tap_map.taps` and `data.extras.taps` recursively. It
  keeps the first `maxTaps` taps and links the trajectory as `irFile`/`irUrl`
  for chaining. `includeZ` keeps a `z` component when the source has one.

## Emitters

An emitter is `emit(records, ctx) => filesWritten`:

```js
/**
 * @param {Array<{ job, type, bucket, key, value, merge?, index?, fps? }>} records
 * @param {{
 *   outDir: string,
 *   config: object,
 *   options: object,        // the emitter entry minus `type`
 *   provenance: object,     // job id -> { engine, jobId, mode, name, credits }
 *   version: number,
 *   generator: string,
 *   log: (message: string) => void,
 * }} ctx
 * @returns {string[] | Promise<string[]>} paths written
 */
```

Built-ins:

| `type` | Writes | Options |
| --- | --- | --- |
| `files` | one file per record, decoded: `<bucket>/<key>.png` for image and sprite-sheet records, `.r.png`/`.t.png` for LUTs, numbered frames for effects, `<bucket>/<key>.wav` for audio clips, `.json` for structured records, IR audio copied next to its descriptor, plus `index.json` | `dir`, `index`, `indexFile`, `merge` |
| `json` | one aggregate bundle: `{ version, generator, provenance, <buckets…> }` | `file`, `pretty`, `provenance`, `shape` (`buckets` \| `records`), `merge` |
| `esm` | a generated module: `export const <name> = …; export default <name>;` | `file`, `export`, `defaultExport`, `header`, `provenance`, `shape`, `merge` |
| `atlas` | `<bucket>/<key>.png` for each sprite-sheet record plus a `<bucket>/<key>.json` sidecar with the animation metadata; deterministic and idempotent | `dir`, `sidecar`, `pretty` |
| `audio-pack` | a self-contained audio bundle: `<bucket>/<key>.wav` for `audio-clip`/`audio-stitch` (decoded or copied) and `ir`, `<bucket>/<key>.json` sidecars for `echo-map`/`ir`, and `manifest.json` (`{ version, generator, provenance, clips, spaces, irs }`) where each clip carries `url`, `seconds`, `sampleRate`, `channels`, `loopStart`, `loopEnd` and `gain` | `dir`, `manifest` (filename or `false`), `pretty`, `sidecar`, `merge` |

```jsonc
{
  "emitter": { "type": "esm", "file": "baked.mjs", "export": "BAKED" }
}
```

or several at once:

```jsonc
{
  "emitters": [
    { "type": "files" },
    { "type": "json", "file": "bundle.json" },
    { "type": "esm", "export": "ASSETS", "provenance": false }
  ]
}
```

### Merge-safe publication

A run is not always a full run: `--only` selects a subset, `enabled: false`
skips jobs, and a failed job produces no record. Rewriting an aggregate
artifact from that subset would silently drop what a previous run published.
Set `merge: true` on an aggregate emitter to load its previous artifact and
overlay this run's records instead:

```jsonc
{
  "emitters": [
    { "type": "esm", "file": "baked.mjs", "export": "BAKED", "merge": true },
    { "type": "json", "file": "bundle.json", "merge": true }
  ]
}
```

```bash
node bin/mothbake.mjs run --config examples/publish.json --out out/publish
node bin/mothbake.mjs run --config examples/publish.json --out out/publish --only nebula-sky
# bundle.json and baked.mjs still carry the rock tile from the first run
```

Merge is per emitter and **opt-in**: without it an emitter replaces its
artifact exactly as before. It is an emitter option rather than a run-wide
`--merge` flag because only the emitter knows whether merging its output is
meaningful — a custom emitter that never asked for merge must not silently
change. Keys this run did not write keep their previous values, and frame
records merge by index, so a partial effect run cannot shift a later frame onto
index 0 (a frame index beyond the previous tail stays an explicit `null`
placeholder). `files` merges its `index.json` by file path (`file` is the
unique key) and unions provenance; `audio-pack` merges `clips`/`spaces`/`irs`
and provenance in its manifest. To read its previous data the `esm` emitter
imports its own previous module (cache-busted) and takes the configured export
or the default — it is code this pipeline generated on an earlier run.

Every artifact is written through a same-directory temp file and renamed, and
each aggregate is checked as exact JSON before the write: NaN, Infinity,
`undefined` keys, array holes, cycles and non-plain objects are rejected with
the path of the offending value instead of being silently mangled. If the check
fails, the previous artifact is left byte-identical. `merge: true` against a
missing artifact behaves exactly like a fresh write; against a corrupt one it
fails loudly rather than overwrite it.

### Animated images and audio

```jsonc
{
  "jobs": [
    {
      "id": "walk-sheet",
      "engine": "qrc-image-v1",
      "bake": { "type": "sprite-sheet", "name": "walk", "maxWidth": 256, "powerOfTwo": true },
      "recorded": { "outputs": { "result": "../test/fixtures/anim.gif" } }
    },
    {
      "id": "sfx-clip",
      "engine": "qrc-audio-v1",
      "bake": {
        "type": "audio-clip",
        "name": "footstep",
        "threshold": 0.001,
        "sampleFormat": "pcm16",
        "loopStart": 0,
        "loopEnd": 0.02
      },
      "recorded": { "outputs": { "result": "../test/fixtures/clip-padded.wav" } }
    },
    {
      "id": "bed-clip",
      "engine": "qrc-audio-v1",
      "bake": {
        "type": "audio-clip",
        "name": "bed-ritual",
        "embed": false,                 // emit a file descriptor, not base64
        "urlBase": "/moth/files",
        "detectLoop": true,             // find a seamless loop seam
        "targetSampleRate": 22050,
        "meta": { "kind": "bed", "bus": "ambience" }
      },
      "recorded": { "outputs": { "result": "../test/fixtures/clip-padded.wav" } }
    },
    {
      "id": "stitch-clip",
      "engine": "qrc-audio-v1",
      "bake": {
        "type": "audio-stitch",
        "name": "bed-stitched",
        "slots": ["a", { "slot": "b", "gain": 0.8 }],
        "crossfadeMs": 5
      },
      "recorded": {
        "outputs": {
          "a": "../test/fixtures/clip-pcm16.wav",
          "b": "../test/fixtures/clip-padded.wav"
        }
      }
    },
    {
      "id": "echo-arena",
      "engine": "otoc-echo-v1",
      "bake": { "type": "echo-map", "name": "arena", "urlBase": "/audio/spaces", "maxTaps": 128 },
      "recorded": { "result": "../test/fixtures/echo-trajectory.json" }
    }
  ],
  "emitters": [{ "type": "atlas" }, { "type": "audio-pack", "dir": "audio" }]
}
```

The `atlas` emitter writes `sprites/walk.png` plus `sprites/walk.json`
(`{ width, height, sheet, frames, loops, fps }`). The `audio-pack` emitter
writes a self-contained bundle plus `manifest.json`:

```
audio/audio/bed-ritual.wav   audio/audio/bed-stitched.wav
audio/spaces/arena.json      audio/manifest.json
```

The `files` emitter is still the default when no `emitter` is configured; it
writes the embedded clips as `<bucket>/<key>.wav` and structured records as
JSON, and copies an `ir`/`audio-clip` file next to its descriptor.

### Reusing engine outputs (asset-id chaining)

Some engines return a reusable artifact — a trained `model`, a `state`
trajectory, an impulse response — that a later job can consume. The runner
captures each output's `output_asset_id` into the job's saved state and, on a
JSON config, writes it back as `assetIds`, so a later run does not have to pay
for the source job again:

```jsonc
{
  "jobs": [
    { "id": "train", "engine": "qrc-train-v2", "bake": { "type": "seed", "name": "train-seed" } },
    {
      "id": "gen",
      "engine": "qrc-gen-v2",
      "inputFrom": { "model": { "job": "train", "slot": "model" } },
      "bake": { "type": "motif", "name": "generated" }
    }
  ]
}
```

`inputFrom` maps an input slot to `{ job, slot }` (or the `"job/slot"`
shorthand; `slot` defaults to the input's own name). Resolution order is: this
run's captured asset id, then the referenced job's persisted `assetIds`, then a
re-upload of that job's archived raw output, then an error. An explicit
`inputFrom` wins over an `inputs` file for the same slot. The captured ids also
appear in the bundle provenance under `<job>.outputs`.

## Extend it

The pipeline is four contracts — **jobs**, **results**, **records**, **emitters**
— and every step between them is a pure function, so the whole thing tests
offline. There are three usual extension points:

- **A custom baker** turns any result into a record of your own shape:
  `bakers: { 'my-baker': (job, ctx) => ({ bucket, key, value }) }`.
- **A custom emitter** writes anything you can write from a file:
  `emitters: [fn]` or `{ name, options, emit }`; return the paths you wrote.
- **A custom value generator** feeds engines that expect a grid:
  `generators: { myGrid: (spec) => grid }`.

```js
// mothbake.config.mjs
import fs from 'node:fs';
import path from 'node:path';

export default {
  bakers: {
    'my-baker': (job, ctx) => ({
      bucket: 'custom',
      key: job.bake.name ?? job.id,
      value: { bytes: ctx.files.get('result')?.length ?? 0 },
    }),
  },
  jobs: [{ id: 'x', engine: 'blur-v1', bake: { type: 'my-baker' } }],
  emitters: [
    { type: 'files' },
    (records, { outDir }) => {
      const target = path.join(outDir, 'counts.txt');
      fs.writeFileSync(target, records.map((record) => record.key).join('\n'));
      return [target];
    },
  ],
};
```

The ESM emitter is the usual way to ship a game's baked data: a bucket-shaped
aggregate with a provenance table is one valid config, and a flat record list
(`shape: "records"`) is another.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) documents the pipeline stages,
the module map, the decoder coverage and the design decisions behind them.
[docs/SYNC.md](docs/SYNC.md) records what this tool shares with its upstream
pipeline and the rule for keeping the two in step.

## Examples

[`examples/manifest.json`](examples/manifest.json) is a runnable config with
texture, sky, normal map, nine effect frames (one per generator), LUT, motif,
two impulse-response jobs, sprite-sheet jobs, embedded and file-mode
`audio-clip` jobs, an `audio-stitch` bed, an `echo-map`, generated audio
seeds/chunks and the `audio-pack` emitter. Every job is recorded, so it works
offline with no key:

```bash
node bin/mothbake.mjs validate --config examples/manifest.json
node bin/mothbake.mjs run --config examples/manifest.json --out out/examples
node bin/mothbake.mjs sources --config examples/manifest.json
```

The recorded fixtures live in [`test/fixtures/`](test/fixtures) (small, trimmed
engine results kept for tests and examples). [`examples/sources.mjs`](examples/sources.mjs)
shows the source-art generator directly.
[`examples/publish.json`](examples/publish.json) is a two-job config whose
aggregate emitters set `merge: true`; re-running it with `--only` shows a
partial run keeping the previously published records.

## Security

`MOTH_API_KEY` is read from the environment only. It is never written to the
config, the raw archive, emitted bundles, or logs. Keep it in your shell or a
gitignored `.env` file; [`.env.example`](.env.example) documents both variables.

## Development

```bash
npm test          # offline: decoders, bakers, config, CLI, a mock API cycle
npm run test:watch
```

The test suite makes no external network calls. The one HTTP test runs against a
local mock that serves the recorded fixtures; everything else is pure functions
and spawned CLI processes.

The README gallery is generated from recorded bakes with Python (Pillow +
numpy); see `python3 scripts/gallery.py --help` for the inputs it expects.

The animated-GIF and WAV fixtures used by the media tests were generated once
with the system `ffmpeg` and committed, so the suite stays offline; regenerate
them with `scripts/make-fixtures.sh` if `ffmpeg` is available.

## License

MIT © mojomast — see [LICENSE](LICENSE). Use it, fork it, ship baked assets with
it.

**Generated-output rights.** mothbake itself is MIT, but the assets it bakes are
yours to account for: output rights are the user's responsibility and remain
subject to the terms of whichever upstream service produced them and to the
rights of any source material you supplied.
