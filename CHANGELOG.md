# Changelog

## Unreleased — 2026-09-25 local workbench upgrade

- Added exact spending plans, layered fingerprints, a durable single-host run
  journal, dependency graph planning and conservative ambiguous-submit recovery.
- Added hash-verified raw archives and offline rebuild support for every built-in
  baker, including multiple local bakes from one remote result.
- Fixed external audio records to store the processed signal rather than aliasing
  provider raw bytes; added filtered production resampling and category-aware
  diagnostics.
- Added bounded variation plans, hash-verified candidates, content-pinned
  approvals, a secured loopback workbench and deliberate approved exports.
- Added transactional versioned packs and a versioned audio-pack emitter.
- Hardened request/upload/download deadlines, aborts, retries, redirect and
  credential boundaries, size limits and expired output-asset URL refresh.
- Added sanitized engine-contract snapshots and preflight validation.
- Added an opt-in, pinned QuantumBlur subprocess backend with an explicit local
  identity and a hard guard preventing `local:` engines from reaching Atlas.
  Quantum Audio is reported as a deferred codec, not `qrc-audio-v1`.
- Added `gc --dry-run` reference/hash reporting with no deletion path, bounded
  JPEG/WebP/MP3/Ogg structural checks, and non-mutating legacy-pointer
  diagnostics.
- Added seam diagnostics, explicit sky projection, preserved HDR LUT masters and
  graph-connectivity/limitation reporting.

All development and tests use local fixtures/fake services; no live Moth job or
credit-bearing request was made.

## Unreleased — 2026-09-24 integration pass

- Added a dependency-free `raw-grid` baker and an offline synthetic example to
  export measured numeric grids without image-oriented rescaling or implicit
  probability normalization.
- Unknown requested modes now remain `null` in generated provenance instead of
  the old invented `"emu"` default. Existing explicitly configured modes and
  records are unchanged. Consumers must not interpret the requested mode or
  manifest credit estimate as confirmed execution backend or billing.
- Bounded remote response/download and ZIP extraction limits protect offline
  and live processing from oversized or corrupt data; large legitimate assets
  may require adjusting the documented limits.
- Documented dated integration observations and their limits separately from
  service contracts; source artifacts remain private and are not packaged.

No release or public publication has been made from this branch.
