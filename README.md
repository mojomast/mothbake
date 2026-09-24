# mothbake

[![CI](https://github.com/mojomast/mothbake/actions/workflows/ci.yml/badge.svg)](https://github.com/mojomast/mothbake/actions/workflows/ci.yml)

**Manifest-driven asset baking with zero runtime dependencies.**

`mothbake` turns a manifest of engine jobs into committed asset files. Each job
names an engine, its inputs and parameters, and the bake that should turn the
result into a portable record. `mothbake` submits the job, decodes the result
itself (PNG, GIF, ZIP, Radiance HDR, WAV, MIDI), and runs the emitters that
write what your project consumes: decoded images, sprite-sheet atlases, one JSON
bundle, a generated ES module, or a custom emitter you write in a few lines.

It is built for pipelines where baked data has to be deterministic, reviewed and
shipped with the code — game textures, skyboxes, normal maps, animation frames,
sprite sheets, material LUTs, impulse responses, audio clips, motifs and seeds.

## Why it fits a repository

- **Zero runtime dependencies.** Every decoder lives in this repository — PNG
  (filters 0–4, colour types 0/2/3/4/6), GIF87a/89a (LZW, interlace,
  transparency, disposal, loops), ZIP (stored/deflate read *and* write),
  Radiance RGBE (flat and modern RLE), WAV (PCM 8/16/24/32-bit and 32-bit float
  decode + encode) and Standard MIDI (format 0/1). Auditable, and installable in
  air-gapped CI.
- **Offline-first.** Any job can carry a `recorded` block, so examples and tests
  run the *same* pipeline with no key and no network.
- **Records are portable data.** A baker returns `{ bucket, key, value }`;
  records diff, cache and ship well, and emitters decide the final shape.
- **Deterministic output.** Bucket order is first-seen, and the ESM emitter is
  covered by a byte-for-byte golden test.
- **Failures are per job.** One bad job is reported and the rest still run; add
  `--strict` to stop at the first failure.
- **Provenance by default.** Bundles carry `engine`, `jobId`, `mode` and
  `credits` per job, and a successful live submission writes its `jobId` back,
  so a re-run downloads instead of paying again.
- **Merge-safe publication.** Aggregate emitters can opt into `merge: true`, so
  a partial run (`--only`, disabled jobs, a failed job) overlays its records on
  the previous artifact instead of dropping everything it did not just bake.
  Writes are atomic and validated as exact JSON first.
- **Offline repair.** `mothbake repair` rebuilds the purely local, file-derived
  records (`ir`, `echo-map`, `audio-clip`, `audio-stitch`) from the raw outputs a
  run already archived — a baker fix can be re-applied to a committed bake
  without re-paying for the engine run.

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

## Install

```bash
git clone https://github.com/mojomast/mothbake.git
cd mothbake
node bin/mothbake.mjs --help
```

That is the whole install — there is nothing to build and nothing to fetch.
Optionally put the command on your `PATH` with `npm link`.

| | |
| --- | --- |
| Node.js | 20 or newer (ESM) |
| Dependencies | none, at runtime or install time |
| API key | `MOTH_API_KEY`, only for `catalog` and for `run` when a selected job is not recorded |

## Quick start

The bundled example runs end to end with no API key and no network, because
every job carries a recorded result:

```bash
git clone https://github.com/mojomast/mothbake.git
cd mothbake
node bin/mothbake.mjs validate --config examples/manifest.json
node bin/mothbake.mjs sources  --config examples/manifest.json
node bin/mothbake.mjs run      --config examples/manifest.json --out out/examples
```

`sources` renders the procedural input art locally (free and deterministic);
`run` bakes all 26 example jobs from the recorded results into
`out/examples/`: decoded files per bucket, `raw/` archives, `index.json`, the
sprite-sheet atlas, an `audio-pack` bundle and a generated `baked.mjs` module.

For your own pipeline, write a manifest and go live:

```bash
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

node bin/mothbake.mjs validate     # check the manifest (no key needed)
node bin/mothbake.mjs sources      # render source art locally, free
node bin/mothbake.mjs run --dry    # plan the run: no API call, no writes
MOTH_API_KEY=... node bin/mothbake.mjs run   # bake for real
```

A live run writes under `mothbake-out/` by default (change it with `--out`):
decoded files per bucket, `raw/` archives of the engine results, `index.json`,
and the `baked.mjs` module the config asked for.

## How the API is used

A job is data: an `engine` plus engine-specific `params`, optional `inputs` to
upload, and a `bake` that turns the finished result into a portable record.
`generateValues` grids are synthesised locally and injected as `params.values`,
so an engine that expects an input grid never needs a committed one.

The snippets below are the example jobs without their `recorded` blocks (the
manifest carries those so the same jobs run offline); everything else matches
[`examples/manifest.json`](examples/manifest.json).

**Image bake.** Upload a PNG, get a decoded texture record. This is the
`rock-tile` job:

```jsonc
{
  "id": "rock-tile",
  "engine": "blur-v1",
  "credits": 1,
  "inputs": { "image": "sources/rock.png" },
  "params": { "strength": 0.32, "style": "ry", "reach": 0.35, "size": 256, "downscale": true },
  "raw": "rock-tile",
  "bake": { "type": "texture-tile", "name": "rock", "size": 64 }
}
```

`texture-tile` decodes the PNG and returns
`{ bucket: "textures", key: "rock", value: { width, height, format: "rgba8", data } }`;
with the default `files` emitter that becomes `textures/rock.png`, and with
`esm` it appears as `BAKED.textures.rock`.

**Generator bakes.** The grid is built locally, injected as `params.values`,
and the engine result is baked into normals. `strata-normals` uses the `height`
variety knobs; `brushed-normals` adds `angle` and `anisotropy` for directional
grain (both jobs are in the example manifest):

```jsonc
[
  {
    "id": "strata-normals",
    "engine": "blur-core-v1",
    "credits": 1,
    "generateValues": { "type": "height", "size": 32, "seed": 11, "kind": "ridge", "freq": 5, "octaves": 6 },
    "params": { "style": "xy", "strength": [0.35, 0.35], "reach": 0.15, "axes": [0, 1], "shots": null, "max_qubits": 20 },
    "raw": "strata-normals",
    "bake": { "type": "normal-map", "name": "strata", "size": 32, "strength": 1.7 }
  },
  {
    "id": "brushed-normals",
    "engine": "blur-core-v1",
    "credits": 1,
    "generateValues": { "type": "height", "size": 32, "seed": 83, "kind": "noise", "freq": 24, "octaves": 2, "angle": 0.4, "anisotropy": 8 },
    "params": { "style": "xy", "strength": [0.5, 0.5], "reach": 0.3, "axes": [0, 1], "shots": null, "max_qubits": 20 },
    "raw": "brushed-normals",
    "bake": { "type": "normal-map", "name": "brushed", "size": 32, "strength": 1.7 }
  }
]
```

`normal-map` resamples the returned grid to `bake.size` and returns
`{ bucket: "normals", key: "strata", value: { width, height, format: "rgba8", data } }`,
a tangent-space normal map. Generator output is pure and deterministic, so the
same manifest always describes the same relief — see
[Value generators](#value-generators) for every knob.

**Effect frames.** The `dust` and `flow` field generators, baked one frame per
job (again from the example manifest):

```jsonc
[
  {
    "id": "dust-frame",
    "engine": "blur-core-v1",
    "credits": 1,
    "generateValues": { "type": "dust", "size": 32, "seed": 149 },
    "params": { "style": "xy", "strength": [0.25, 0.25], "reach": 0.15, "axes": [0, 1], "shots": null, "max_qubits": 20 },
    "raw": "dust-frame",
    "bake": { "type": "effect-frame", "name": "effect-dust", "index": 0, "fps": 10, "size": 48, "tint": "quantum" }
  },
  {
    "id": "flow-frame",
    "engine": "blur-core-v1",
    "credits": 1,
    "generateValues": { "type": "flow", "size": 32, "seed": 173 },
    "params": { "style": "xy", "strength": [0.5, 0.5], "reach": 0.3, "axes": [0, 1], "shots": null, "max_qubits": 20 },
    "raw": "flow-frame",
    "bake": { "type": "effect-frame", "name": "effect-flow", "index": 0, "fps": 10, "size": 48, "tint": "plasma" }
  }
]
```

`effect-frame` returns one tinted RGBA frame. Records with the same `bucket` and
`key` merge by `index` into `{ fps, frames: [...] }`, so an animated effect is
simply more jobs (or one GIF job with `all: true`); with `files` these land as
`effects/effect-dust.000.png` and `effects/effect-flow.000.png`.

**Audio bakes.** An impulse response with its descriptor and tap map:

```jsonc
{
  "id": "cavern-ir",
  "engine": "retrocausal-echo-v1",
  "credits": 2,
  "params": { "emit": "audio", "ir_seconds": 4, "sr": 22050, "output_format": "pcm_16", "lattice": "square", "width": 4, "height": 5, "decay": 0.85, "feedback": 0.5, "diffusion_ms": 200, "min_level": 0.03, "seed": 12345, "include_tap_map": true },
  "raw": "cavern-ir",
  "bake": { "type": "ir", "name": "cavern", "urlBase": "/audio/irs" }
}
```

`ir` (alias `ir-descriptor`) copies the decoded WAV next to a descriptor record
that carries `file` (relative to the output dir), `url`, `seconds`,
`sampleRate`, `format` and the tap map. `audio-clip`, `audio-stitch` and
`echo-map` follow the same pattern — see [Bakers](#bakers) for every option.

**Chaining outputs.** Engines that return a reusable artifact — a `model`, a
`state` trajectory, an impulse response — expose an `output_asset_id`, and a
later job can consume it with `inputFrom` instead of paying for the source job
again:

```jsonc
{
  "id": "gen",
  "engine": "qrc-gen-v2",
  "inputFrom": { "model": { "job": "train", "slot": "model" } },
  "bake": { "type": "motif", "name": "generated" }
}
```

`inputFrom` resolves from this run's captured asset id, then the referenced
job's persisted `assetIds` (written back to JSON configs), then a re-upload of
that job's archived raw output. Captured ids also appear in bundle provenance
under `<job>.outputs`.

## CLI

```
mothbake <command> [options]

Commands:
  catalog            List the engines the API exposes and their credit cost
  validate           Validate the config and report every problem
  sources            Generate procedural source art (PNG/WAV/MIDI) locally
  run                Resolve jobs, bake records, and run the emitters
  repair             Rebuild local records from raw outputs, without the API

Options:
  -c, --config <file>  Config file (default: mothbake.config.mjs / .js / mothbake.json)
  -o, --out <dir>      Output directory (default: mothbake-out; sources default: sources)
      --only <id>      Only this job (repeatable or comma-separated); with sources: pattern names
      --force          Ignore recorded fixtures and cached job ids; submit fresh jobs
      --dry            Print what would run without touching the API or writing files
      --strict         Stop at the first failed job instead of continuing
      --base <url>     Override the API base URL
  -h, --help           Show this help
  -v, --version        Show the version
```

| Command | Exits non-zero when… |
| --- | --- |
| `run` | any job fails |
| `validate` | the config has errors (warnings are printed but do not fail the run) |
| `repair` | a selected local job has no raw archive or cannot be rebuilt |
| `catalog` | `MOTH_API_KEY` is not set |

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
   written atomically and aggregates are validated as exact JSON first; with
   `merge: true` an aggregate overlays this run's records on its previous
   artifact, so a partial run never drops published data.

A failed job is reported and the remaining jobs still run; the command exits 1
at the end. Pass `--strict` (or `strict: true` to `runConfig`) to stop at the
first failure instead. Successful live submissions record their `jobId` back
into a JSON config, so re-running downloads the existing result instead of
paying for another run; add `--force` to submit fresh jobs anyway.

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

A config is a JSON file or an ES module (`mothbake.config.mjs` / `.js`) whose
default export is the config object. Default filenames, in priority order:
`mothbake.config.mjs`, `mothbake.config.js`, `mothbake.json` (override with
`--config`).

```jsonc
{
  "version": 1,                              // optional; stamped into bundles
  "generator": "mothbake",                   // optional; stamped into bundles
  "baseUrl": "https://api.mothquantum.com",  // optional; env/flags win
  "jobs": [ /* required */ ],
  "sources": { /* optional; used by `mothbake sources` */ },
  "emitter": { "type": "files" },            // optional; default { "type": "files" }
  "emitters": [ /* optional; use instead of emitter for several */ ],
  "bakers": { /* module config only: custom bakers */ },
  "generators": { /* module config only: custom value generators */ },
  "writeBack": true,                         // optional; record jobIds into JSON configs
  "comment": "Bake manifest"                 // optional; ignored, for readers
}
```

Relative paths in `inputs` and `recorded` are resolved against the config file's
directory, as is `sources.dir`; `--out` is resolved against the working
directory.

### Jobs

| Field | Meaning |
| --- | --- |
| `id` | Required, unique. Names the job in plans, failures and provenance. |
| `engine` | Required API engine id. Nothing is hardcoded per engine. |
| `params` | Engine parameters, passed through as-is. |
| `inputs` | `{ slot: local path }` files to upload. `input` is accepted as an alias; if both appear, `inputs` wins with a warning. |
| `inputFrom` | `{ slot: { job, slot } }` or the `"job/slot"` shorthand; reuses an earlier job's output asset (see [How the API is used](#how-the-api-is-used)). |
| `generateValues` | Local grid spec injected as `params.values` (see [Value generators](#value-generators)). |
| `bake` | Baker and its options (see [Bakers](#bakers)); omit it to only archive the raw output. |
| `recorded` | Offline substitute for the API call (see [Recorded results](#recorded-results)). |
| `raw` | Raw-output directory name under `<out>/raw/` (default: the job `id`). |
| `enabled` | `false` skips the job. |
| `jobId` | Cached job id; reused only while the API reports it `completed`. |
| `credits`, `mode`, `assetIds`, `comment` | Provenance and metadata: `credits` and `mode` are passed through, `assetIds` is the persisted `inputFrom` state written back after a run, `comment` is ignored. |

### Recorded results

A `recorded` block replaces the API round trip: `outputs` maps output slots to
local files, and `result` is the inline JSON result (a file path or an inline
value). This is how the test suite and the examples run without a key, and how
you can commit known-good results and re-bake them deterministically.

```jsonc
{
  "recorded": {
    "outputs": { "result": "../fixtures/tile.png" },
    "result": "../fixtures/grid.json"   // or an inline JSON value
  }
}
```

### Sources

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
`mothbake sources` writes only the audio/chunk files a job actually references;
the filter is the set of `inputs` basenames across all jobs (patterns, audio
seeds, chunk archives, plus `motif.mid`).

### Value generators

`generateValues` synthesizes the grid some engines consume without shipping one
in the config. The grid is injected as `params.values` at resolve time, so it
works identically for live and recorded runs. Built-ins:

| `generateValues.type` | Produces | Options |
| --- | --- | --- |
| `height` | seamlessly tiling height field | `size`, `seed`, `kind` (`noise` \| `ridge` \| `cells`), `freq`, `octaves`, `angle`, `anisotropy` |
| `radial` | expanding shock ring | `size`, `seed`, `frame` |
| `portal` | ring with spokes and a hot core | `size`, `seed`, `frame` |
| `spark` | bright core with needle rays | `size`, `seed`, `frame` |
| `bloom` | explosion core inside an expanding shock ring | `size`, `seed`, `frame` |
| `vortex` | swirling ring of arms around a bright core | `size`, `seed`, `frame` |
| `contract` | contracting capture ring with radial ticks | `size`, `seed`, `frame` |
| `rise` | motes rising through a soft heal column | `size`, `seed`, `frame` |
| `shield` | expanding hexagonal bubble shell with seams | `size`, `seed`, `frame` |
| `snow` | drifting flakes, seamless across frames | `size`, `seed`, `frame` |
| `dust` | soft drifting dust/damp patches | `size` (default 64), `seed` (default 149) |
| `flow` | directional wear/flow streaks along +x | `size` (default 64), `seed` (default 173) |

Every generator is pure and deterministic, returns a square `size`×`size` grid
of values in `[0, 1]`, defaults to 32 px unless noted, and for the animated
families accepts a `frame` index (with a fixed per-type `seed` default).

`height` is the one with variety knobs:

- `kind` — `noise` (default), `ridge` (folded into ridges: 1 − |2h − 1|) or
  `cells` (a seeded sine lattice).
- `freq` — base tiling frequency (default 8; 4 for `cells`). Higher is finer.
- `octaves` — fBm octaves (default 5).
- `angle` — rotates the sampling lattice before sampling, turning the relief
  into directional streaks. Multiples of π/2 keep the exact edge wrap; other
  angles trade exact edge continuity for direction.
- `anisotropy` — stretches along the rotated v axis (`>= 1`). With `angle: 0`,
  an integer value makes the repeating v bands line up exactly with the texture
  edge.
- With no options the `noise`/`ridge` output is byte-identical to the
  pre-knob formula. `cells` derives its lattice phases from the seed, so two
  cell jobs no longer render the same lattice.

`dust` and `flow` are field masks rather than shapes: `dust` gates a
low-frequency wrapping field into soft accumulations, and `flow` shapes
anisotropic wrapping noise into lanes that run along +x.

Custom generators can be added from a module config:
`generators: { myGrid: (spec) => grid }`.

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
- Grid-based bakers accept the inline result, a `{ result: … }` response, or a
  `{ output: … }` value, so the same config works for live and recorded runs.
- `sprite-sheet` packs the composited GIF frames left-to-right, wrapping to a
  new row at `maxWidth` (default 2048). The sheet is trimmed to the used area
  unless `powerOfTwo` pads both axes. Consecutive identical frames are not given
  a new rectangle: with `dedupe` (default true) the duplicate keeps its own
  `delay` and reuses the previous rectangle, so playback timing is unchanged;
  set `dedupe: false` to give every frame its own rectangle.
- `ir.file` is relative to the output dir. `url` is only populated when the bake
  config sets `url` (with `{raw}`, `{slot}`, `{file}` placeholders) or `urlBase`
  (e.g. `"/audio/ir"` → `/audio/ir/<raw>/result.wav`).
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
- `audio-stitch` concatenates ordered WAV slots (`slots`/`order`; entries are a
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

With no `emitter`/`emitters`, a single `files` emitter runs. Built-ins:

| `type` | Writes | Options |
| --- | --- | --- |
| `files` | one file per record, decoded: `<bucket>/<key>.png` for image and sprite-sheet records, `.r.png`/`.t.png` for LUTs, numbered frames for effects, `<bucket>/<key>.wav` for audio clips, `.json` for structured records, IR audio copied next to its descriptor, plus `index.json` | `dir`, `index`, `indexFile`, `merge` |
| `json` | one aggregate bundle: `{ version, generator, provenance, <buckets…> }` | `file`, `pretty`, `provenance`, `shape` (`buckets` \| `records`), `merge` |
| `esm` | a generated module: `export const <name> = …; export default <name>;` | `file`, `export`, `defaultExport`, `header`, `provenance`, `shape`, `merge` |
| `atlas` | `<bucket>/<key>.png` for each sprite-sheet record plus a `<bucket>/<key>.json` sidecar with the animation metadata; deterministic and idempotent | `dir`, `sidecar`, `pretty` |
| `audio-pack` | a self-contained audio bundle: `<bucket>/<key>.wav` for `audio-clip`/`audio-stitch` (decoded or copied) and `ir`, `<bucket>/<key>.json` sidecars for `echo-map`/`ir`, and `manifest.json` (`{ version, generator, provenance, clips, spaces, irs }`) where each clip carries `url`, `seconds`, `sampleRate`, `channels`, `loopStart`, `loopEnd` and `gain` | `dir`, `manifest` (filename or `false`), `pretty`, `sidecar`, `merge` |

One emitter:

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

The `atlas` emitter writes `sprites/walk.png` plus `sprites/walk.json`; the
`audio-pack` emitter writes a self-contained bundle, e.g. under the example
manifest's `"dir": "pack"`:

```
pack/audio/bed-ritual.wav   pack/audio/bed-stitched.wav
pack/irs/cavern.wav         pack/irs/cavern.json
pack/spaces/arena.json      pack/manifest.json
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
unique key) and unions provenance; `audio-pack` merges its `clips`/`spaces`/`irs`
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

## Extend it

The pipeline is four contracts — **jobs**, **results**, **records**,
**emitters** — and every step between them is a pure function, so the whole
thing tests offline. Three usual extension points:

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

## Examples

[`examples/manifest.json`](examples/manifest.json) is a runnable config with a
texture, a sky, three normal maps (default noise, ridged strata, and an
angled/anisotropic brushed field), an effect frame per generator (radial,
portal, spark, bloom, vortex, contract, rise, shield, snow, dust and flow), a
LUT, a motif, two impulse responses, sprite-sheet and audio jobs, an
`echo-map`, generated audio seeds/chunks and the `audio-pack` emitter. Every
job is recorded, so it works offline with no key:

```bash
node bin/mothbake.mjs validate --config examples/manifest.json
node bin/mothbake.mjs run --config examples/manifest.json --out out/examples
node bin/mothbake.mjs sources --config examples/manifest.json
```

The recorded fixtures live in [`test/fixtures/`](test/fixtures) (small, trimmed
engine results kept for tests and examples). [`examples/sources.mjs`](examples/sources.mjs)
shows the source-art generator directly, and
[`examples/publish.json`](examples/publish.json) is a two-job config whose
aggregate emitters set `merge: true`; re-running it with `--only` shows a
partial run keeping the previously published records.

## Documentation map

| Document | Covers |
| --- | --- |
| This README | Install, quick start, API usage, CLI, configuration, generators, bakers and emitters. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Pipeline stages, module map, design decisions and the test layout. |
| [docs/SYNC.md](docs/SYNC.md) | What this repository shares with the private upstream pipeline, and the rule for keeping the two in step. |
| [examples/](examples) | Runnable manifests, offline configs and the source-art script. |
| [test/](test) | Offline `node --test` suite and the recorded fixtures it runs against. |
| [scripts/gallery.py](scripts/gallery.py) | Regenerates the gallery images from recorded bakes. |

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

The gallery images are generated from recorded bakes with Python (Pillow +
numpy); see `python3 scripts/gallery.py --help` for the inputs it expects. The
animated-GIF and WAV fixtures used by the media tests were generated once with
the system `ffmpeg` and committed, so the suite stays offline; regenerate them
with `scripts/make-fixtures.sh` if `ffmpeg` is available.

## License

MIT © mojomast — see [LICENSE](LICENSE). Use it, fork it, ship baked assets with
it.

**Generated-output rights.** mothbake itself is MIT, but the assets it bakes are
yours to account for: output rights are the user's responsibility and remain
subject to the terms of whichever upstream service produced them and to the
rights of any source material you supplied.
