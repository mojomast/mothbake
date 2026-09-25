# Mothbake local-first workbench upgrade

Updated: 2026-09-25

This is the working implementation plan. It is intentionally the only upgrade
plan for this effort; completed work and validation evidence are recorded here
and in `mothbake-upgrade-validation.md` rather than in parallel audit reports.

## Baseline

- Working branch: `work/mothbake-workbench-upgrade-2026-09-25`
- Starting revision: `12399720f0528151d16b5f1c565c16c452732f82`
- Upstream default branch at inspection: `4416f88ff4d12e31e0de693ec11682ba2a252155`
- The starting revision intentionally includes the already-reviewed
  `work/portfolio-learnings-2026-09-24` changes. The worktree was not reset to
  the older review baseline.
- Baseline `npm test`: 219 passed, 0 failed on Node.js 22.17.0.
- Runtime dependencies: none. Optional media and engine integrations must stay
  optional.
- Live job submission is prohibited for this implementation. Development uses
  recorded fixtures and fake APIs only.

## Product slice and shared contracts

The implementation follows one flow:

```text
declarative recipe -> frozen plan -> run journal -> archived raw results
  -> local bake -> candidates + quality reports -> content-pinned approval
  -> transactional pack -> offline rebuild
```

These concepts remain separate:

1. **Recipe** — editable intent. It never stores execution state.
2. **Plan** — a frozen, bounded expansion of selected jobs and variations,
   including input hashes, dependencies, costs and unknowns.
3. **Run journal** — versioned state transitions and remote identities.
4. **Content store/archive** — immutable raw and derived bytes addressed by
   SHA-256, never by a signed URL.
5. **Candidate** — one inspectable result with exact parameter delta,
   provenance and quality report.
6. **Approval lock** — pins content hashes and the plan that was approved.
7. **Export** — a transactional, versioned delivery pack whose identity
   depends on approved baked content and exporter options.

Fingerprints are layered rather than overloaded:

- generation recipe: engine/backend/requested mode/version, canonical params,
  input content hashes, generator identity and dependency identities;
- generation instance: recipe fingerprint plus the remote or recorded instance;
- raw artifact: content hash and slot identity;
- local bake: raw hashes, baker options and baker/schema identity;
- export: approved baked hashes, exporter options and exporter identity.

A recipe fingerprint means “equivalent requested work”, not “a stochastic
rerun will return identical bytes”. Unknown engine versions and legacy
provenance stay explicitly unverified.

## Milestone A — correctness and recovery

- [x] Inspect current HEAD, package surface, tests, CI, runner, API wrapper,
  archives, bakers, emitters and repair flow.
- [x] Run the unmodified baseline suite.
- [x] Research the current public Moth documentation and OpenAPI contract; see
  `moth-api-contract.md`.
- [x] Fix `audio-clip`/`audio-stitch` external-file output so it contains the
  processed signal, not the immutable provider raw file.
- [x] Add embedded/external decoded-sample equivalence and traversal tests.
- [x] Add a versioned, atomic run journal independent of JSON/module recipes.
- [x] Persist prepared/submitting intent before a paid request and persist the
  returned job id before polling.
- [x] Represent ambiguous submission, remote failure and local failure as
  distinct states. Never auto-resubmit an ambiguous request.
- [x] Add a single-host exclusive lock with explicit, conservative recovery.
- [x] Integrate layered fingerprints so baker/export-only changes remain local.
- [x] Keep legacy `jobId` import compatible but mark insufficient lineage
  unverified.

Milestone acceptance: the fake service proves a returned job id survives poll
and emitter failures; resume never creates a second submission; processed
external audio decodes equivalently to embedded audio.

## Milestone B — graph, archive and candidate browser

- [x] Replace manifest-order `inputFrom` behavior with a validated topological
  plan, cycle/missing-reference errors and `--only` ancestor expansion.
- [x] Reject stale upstream dependencies by fingerprint; allow an ancestor
  rebuilt from its current hash-verified archive to satisfy a dependency.
- [x] Archive slot metadata, content hashes, result shape, actual generation
  identity, backend provenance when reported, and baker identity.
- [x] Generalize offline rebuild to every built-in baker whose exact archived
  inputs are present; fail actionably on missing/corrupt blobs.
- [x] Add versioned approval locks that pin content, never mutable names.
- [x] Publish packs through a validated staging version and atomically promote
  a small current-version pointer. Keep prior complete versions for rollback.
- [x] Deliver a loopback-only, read-only candidate browser using the same core
  plan/archive contracts as the CLI.
- [x] Show image comparison/tiled preview, audio waveform/loop diagnostics,
  provenance, parameters and quality warnings.

Milestone acceptance: on a clean machine with credentials removed, a recorded
example can be verified, rebaked and exported from its archive; a browser test
can inspect candidates without any submission request.

## Milestone C — refinement, approvals and production packs

- [x] Add a declarative bounded variation schema: baseline, allowed parameters,
  finite ranges/choices, constraints, count and frozen random choices.
- [x] Add favorite/reject/note/approve/supersede operations and stable JSON CLI
  output. Mutating a frozen paid plan invalidates its approval.
- [x] Add category-aware audio quality reports and a dependency-free production
  resampler adapter. Never silently use preview-quality linear interpolation
  for a requested production export.
- [x] Ship one coherent panel-material family: aligned color, height, normal,
  roughness and wear outputs plus a conventional local baseline. Derived maps
  are labelled synthesis heuristics.
- [x] Add a transactional audio variation pack with stable names, tags, groups,
  optional weights and exported-byte validation.
- [x] Add a Godot-first exporter with ready-to-use material resources and a
  small clean consumer project. Runtime import is only marked verified when an
  available Godot executable actually loads it.
- [x] Complete one zero-credential journey: open example, produce local
  variations, compare, refine, approve, export and rebuild offline.

## Milestone D — capability discovery and justified extensions

- [x] Cache sanitized engine contracts with API/schema version, retrieval time
  and verification level.
- [x] Validate known parameter/input/output contracts before spending; unknown
  cost is not zero.
- [x] Add a run-level budget gate around the frozen plan and journal lock. It is local
  admission control, not a provider billing guarantee.
- [x] Add request deadlines, abort propagation and safe refresh of expired
  download URLs through documented job/asset GET endpoints.
- [x] Investigate optional QuantumBlur/audio adapters only against official
  source and license information. They receive distinct backend identities and
  never silently fall back to Moth.
- [x] Audit texture tiling, sky projection, HDR LUT and level-graph claims;
  downgrade unsupported promises or add measured diagnostics.

## Parallel ownership and integration order

At most two direct implementation workstreams run concurrently.

- **Execution/state owner:** journal, identities and dependency planning in
  isolated modules and tests.
- **Asset-correctness owner:** processed external audio and exported-byte tests.
- **Lead:** API contract, shared schemas, runner/CLI integration, security,
  documentation and integrated verification.

After the foundational modules land, workbench UI and production exporters get
exclusive path ownership. Shared files (`runner`, `config`, `cli`, package
exports and docs) remain lead-owned to avoid conflicting contracts.

## Safety and compatibility gates

- Existing recorded/offline runs, raw archives, asset chaining and emitters stay
  compatible unless a migration is documented and tested.
- `--force` is not spending approval. New remote submissions require a frozen
  plan and an explicit separate approval/budget gate.
- No key enters frontend code, browser storage, archives, fixtures or reports.
- The workbench binds to loopback and rejects hostile Host/Origin values and
  filesystem traversal.
- Imported recipes are declarative data; executable module configs remain a
  trusted local extension and are never accepted through the browser.
- Signed URLs are ephemeral transport, redacted from errors, and never durable
  identity.
- Do not claim distributed exactly-once execution. The supported boundary is
  one host with filesystem locking plus conservative ambiguous-outcome handling.

## Non-goals

Hosted SaaS, public tunnelling, multi-user authentication, remote
administration, a generic media editor, a speculative plugin framework, an MCP
runtime, many game-engine exporters, a wholesale TypeScript/frontend rewrite,
or live credit-bearing validation during this task.

## Remaining optional/advanced work

The production vertical slice does not depend on these items:

- The official QuantumBlur contract/license was reviewed and an opt-in pinned
  local adapter is implemented. Quantum Audio remains deliberately deferred as
  a codec round-trip, not a `qrc-audio-v1` substitute. Neither can silently
  become a hosted submission.
- A dedicated impulse-response convolver in the browser and optional
  level-matched preview toggle would improve auditioning; exported audio is
  already unchanged and category-aware diagnostics are available.
- `mothbake gc --dry-run` now reports references, hashes and conservative
  dispositions. Deletion remains intentionally unimplemented; candidate
  rejection never deletes evidence and approvals/versioned packs are retained.
- JPEG, WebP, MP3 and Ogg now receive bounded structural verification. This is
  not full codec decoding. Unsupported pointer-v1 packs are diagnosed without
  mutation; migration remains deferred until an authentic v1 fixture exists.
- Additional Three.js/MCP adapters remain intentionally deferred until the
  shipped CLI/core schemas settle.
- Authenticated read-only service discovery, any live submission, provider
  billing/backend observation and Godot runtime import need their respective
  authorized environments. They are not inferred from fixtures/source checks.
