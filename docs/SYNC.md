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
| ZIP read (stored + deflate) | yes | yes | Here verifies the local header and inflated size. |
| Radiance RGBE `.hdr` (flat + modern RLE) | yes | yes | Identical maths. |
| WAV inspect | yes | yes | Here also reports container format and frame count. |
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

### Value generators

| Feature | Upstream | Here | Notes |
| --- | --- | --- | --- |
| `height` (`noise` \| `ridge` \| `cells`) | yes | yes | Identical constants and rounding. |
| `radial` | yes | yes | Identical. |
| `portal` | yes | yes | Identical. |
| `spark` | yes | yes | Identical. |

### Source-art patterns

| Feature | Upstream | Here | Notes |
| --- | --- | --- | --- |
| Families: `noise`, `panels`, `rivets`, `circuit`, `stripes`, `corrugated`, `grating`, `diamond`, `weave`, `mesh`, `stars` | yes | yes | Identical renderer. |
| Built-in recipes | yes | yes | 24 recipes; rendered output is byte-for-byte identical. |
| Star-band knobs (`cloudFreq`, `starDensity`) | yes | yes | — |
| Pattern knobs (`panels`, `ribs`, `cells`) | yes | yes | — |
| Configurable recipe set | no | yes | Here-only: recipes can come from config instead of code. |

### Runner, CLI and config

| Feature | Upstream | Here | Notes |
| --- | --- | --- | --- |
| Recorded fixtures (offline runs) | no | yes | Here-only; used by tests and examples. |
| Cached `jobId` reuse and `--force` | yes | yes | Here writes ids back only when they change. |
| Dry run without network or writes | yes | yes | Here also reports a per-job action plan. |
| Stop at the first failure (`strict`) | yes | yes | Library option plus the `--strict` flag. |
| `--only` selection | yes | yes | Here also accepts repeats and comma-separated ids, and validates them. |
| `catalog`, `sources`, `run` commands | yes | yes | — |
| `validate` command and config schema checks | no | yes | Here-only. |
| Custom bakers / generators / emitters from a module config | no | yes | Here-only extension points. |
| Emitters (files / JSON / ESM) | partial | yes | Upstream writes one hard-coded module; here emitters are a registry. |
| API client (engines, jobs, assets, polling) | yes | yes | Injectable `fetch`/`sleep` for offline tests. |

## Deliberately not ported

These are private-consumer concerns, so they stay upstream:

- Canonical asset-kind names and the consumer's fixed vocabulary. Here, buckets
  and keys are whatever a config says.
- Engine and parameter choices baked into a job list. Here, jobs are data.
- Branded identifiers, private paths and API credentials.
- The consuming runtime's module shape. Here it is one possible `esm` emitter
  config, not a special case.

## Sync log

- **2026-09-17** — Ported the upstream `strict` run option (with the `--strict`
  CLI flag) and the `effect-frame` `effect` key alias. Added offline examples
  for the `portal` and `spark` value generators, extended the source-art example
  across all pattern families, and added tests for each. Recorded this sync
  record and capability matrix.
