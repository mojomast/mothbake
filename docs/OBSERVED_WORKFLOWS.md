# Working with recorded engine outputs

These are **observations from a private September 2026 integration**, not a
service contract or a redistribution of its media. The bundled example below
is handcrafted synthetic data; it makes no claim to be a live provider result.
No key, network access, or paid run is needed:

```bash
node bin/mothbake.mjs validate --config examples/raw-grid.json
node bin/mothbake.mjs run --config examples/raw-grid.json --dry
node bin/mothbake.mjs run --config examples/raw-grid.json --out out/raw-grid
node -e 'const f=require("./out/raw-grid/field.json"); console.log(f.grids.field.values)'
```

`raw-grid` copies an inline two-dimensional numeric `.output` field into
`grids.<name> = { width, height, values }`, rejecting ragged/nonfinite arrays.
It does **not** normalize or reclassify the values: `[[0,8],[1,2]]` sums to 11,
not 1. A Blur Core result seen in the integration contained nonnegative,
max-rescaled output, not a probability distribution. If a consumer needs
probabilities or display-scaled intensities, calculate and label that **local
transformation** separately. The original JSON remains at
`raw/<job>/inline-result.json` in new archives (`result.json` is a legacy
layout); image bakers may apply display rescaling but never replace that raw
archive. `.mothbake-archive.json` binds the generation identity and exact blob
hashes.

## Verify the returned artifact, not the requested shape

- A 64×64 PNG plate failed at asset completion during those runs; 256×256
  source plates succeeded with engine output sizes as small as 16 or 64.
  Using 256×256 source plates is a tested recipe, **not** a universal minimum
  accepted input size. A first request with `mode: "simulator"` failed
  ambiguously; omit the platform `mode` override rather than guessing. The
  reviewed successful echo request put `machine: "aer"` **inside `params`**
  for engines supporting that parameter (`params.machine` in a mothbake
  manifest), and omitted the separate top-level platform `mode` entirely.
- An OTOC trajectory arrived in a typed inline result envelope with `.output`
  and provider provenance. Retain the whole raw envelope, extract the exact
  measured trajectory for a subsequent IR input, and hash both source and
  derived bytes. `echo-map` can extract trajectory taps but is not a generic
  trajectory serializer. A requested mode is not proof of the actual backend.
- One corrected QRC image run used 32 training tokens after an earlier
  `invalid_input` said the training sequence needed **more than 16** tokens.
  That error was not advertised by the schema; check current catalog and
  validate the actual response. A request for 24 frames at 6 fps yielded a
  GIF of 18 encoded frames lasting 3.9 seconds. Read decoded `frames[].delay`
  and disposal/composited pixels rather than inferring timing from request
  parameters. An output vocabulary ZIP matched its input bytes in that run;
  do not label that classical input ZIP as a newly generated engine output.
- MIDI output was a type-0 file with a different note count from the authored
  seed. Decode tempo and running status; rendering MIDI to sound with a local
  synthesizer is a separate classical step with possible timbre/expression
  losses. ZIP members can contain genuine upstream engine outputs **and**
  locally assembled inputs: keep provenance per member.
- One Retro render accepted a measured trajectory without an audio input; a
  second explicitly supplied a mono float32 unit impulse. That unit-impulse
  result was a sparse stereo, 22,050 Hz, two-second WAV with negative taps,
  not evidence that arbitrary processed music is an IR. The existing `ir`
  baker inspects a returned WAV and emits a descriptor; preserve any later
  resampling, gain, convolution and normalization as *local DSP* metadata.

## Credit and provenance boundaries

Manifest `credits` is a supplied **estimate**, not a confirmed bill. A missing
mode is represented as `null` in new bundle provenance rather than an invented
`"emu"`; an explicitly requested mode is still a request, not backend proof.
Consumers of historical generated bundles should not treat their old default
`"emu"` as observed execution evidence.

Current recovery order is: recorded fixture → matching hash-verified archive
rebuild → journal resume/status check → new submission only from an explicitly
approved frozen plan. The journal persists intent before POST and a returned
job id before polling. A crash in `submitting`, or a request whose response is
lost, becomes a reconciliation gate; inspect documented job history and billing
without resubmitting. `--force` cannot clear that gate and does not bypass
`--approve-spend <exact-plan-fingerprint>`. The journal/lock is single-host
coordination, not a provider billing cap. Do not infer free or charged runs from
mode.

Do not redistribute private recordings, raw packs, signed URLs, credentials or
unreviewed API errors with examples. In a shared dataset verify byte hashes
and safe relative paths against an immutable root, and label provider outputs
separately from your classical transformations. This synthetic example is
redistributable; the observed integration artifacts are not included here.

`createApi` bounds response/download bodies and diagnostics, redacts credential
and signed-URL-shaped details, rejects API redirects before bearer credentials
can cross origins, and sends no bearer header to object storage. Treat all
remote errors/progress as untrusted/private anyway; never publish them without
review. Expired output URLs are refreshed through documented result/asset GETs,
never by creating another generation.
