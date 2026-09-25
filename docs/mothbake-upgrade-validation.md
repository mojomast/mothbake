# Mothbake upgrade validation log

Updated: 2026-09-25

Only commands actually run are recorded as passed. Live API compatibility is
not inferred from offline fixtures.

## Environment and baseline

Working tree created from
`12399720f0528151d16b5f1c565c16c452732f82` on branch
`work/mothbake-workbench-upgrade-2026-09-25`.

```text
$ node --version
v22.23.1

$ npm test
# tests 219
# pass 219
# fail 0
# duration_ms 751.391133
```

CI inspected: `.github/workflows/ci.yml` runs the offline `npm test` suite on
Node 20 and 22. No install/build step or runtime dependency is required.

## API contract retrieval

```text
$ curl -fsSL -A mothbake-contract-research/1.0 \
    https://api.mothquantum.com/openapi.json \
    -o /tmp/opencode/moth-openapi-2026-09-25.json

OpenAPI: 3.1.0
API title/version: moth-api v0.41.0
Bytes: 362971
SHA-256: a383dc2972189e83b6adc54f36be2cd23745ffb60e0284edc8b3182845682b91
```

Public documentation pages for authentication, engines, submission, job
status/results, assets, errors and endpoints were retrieved successfully. No
authenticated endpoint was called. No API key was read or printed. No live job,
asset upload or credit-bearing operation occurred.

Contract conclusions are in `moth-api-contract.md`. In particular, current
official sources confirm Mothbake's `/api/v1/jobs/{id}/status` polling and
`/api/v1/jobs/{id}/result` retrieval paths.

## Reproduced risks before changes

- `src/bakers/audio.mjs` makes `embed:false` point at
  `ctx.saved[slot].relative`, which is the immutable raw provider output even
  after trim/resample/mixdown/normalization/crossfade. Existing tests only prove
  raw copy behavior. This confirms the inherited external-audio correctness
  issue.
- `src/runner.mjs` stores a returned live job id only on the mutable in-memory
  job object and writes JSON config state after emitter completion. Polling or
  emitter failure can therefore prevent durable persistence; module configs are
  never rewritten. This confirms the need for an independent journal.
- `inputFrom` resolves in manifest/run order and validation only warns on a
  forward reference. There is no topological plan or cycle detection.
- `repair` is limited to a small allow-list of local baker types rather than
  verifying/rebuilding every baker from archived inputs.
- Emitters use atomic individual writes, but a multi-file pack has no staging
  version/promotion boundary.

## Implementation verification

This section is updated after each integrated milestone.

### Milestone A

Status: implemented and integrated locally.

- [x] Processed external audio equivalence tests
- [x] Journal/recovery tests
- [x] Fingerprint layering tests
- [x] Fake-service no-duplicate-submission tests
- [x] Full `npm test` regression run

Focused commands actually run successfully include:

```text
node --test test/identity.test.mjs test/job-graph.test.mjs \
  test/run-journal.test.mjs test/execution-plan.test.mjs test/archive.test.mjs
21 passed, 0 failed

node --test test/mock-server.test.mjs
10 passed, 0 failed

node --test test/recovery.test.mjs
3 passed, 0 failed

node --test test/api-contract.test.mjs test/api-limits.test.mjs \
  test/rate-limit.test.mjs
37 passed, 0 failed

node --test test/audio-quality.test.mjs test/audio.test.mjs test/media.test.mjs
39 passed, 0 failed
```

Recovery coverage includes durable job id before polling, polling and emitter
failure, ambiguous submit with no automatic retry, journal lock/corruption,
archive-only resume, stale dependency refusal and immutable raw conflicts.

### Milestone B

Status: implemented and integrated locally.

- [x] Dependency graph tests
- [x] Archive integrity and clean offline rebuild
- [x] Transactional pack interruption/rollback tests
- [x] Candidate browser HTTP/security tests and a real Chromium render

The browser journey was checked with installed Chromium 153 in headless mode
against a temporary loopback server. The rendered DOM contained the candidate,
source/result detail, 3×3 tiled preview, provenance and approval controls. This
was not a full pointer-driven interaction test; protected mutation behavior is
covered through real HTTP requests in `test/workbench-server.test.mjs`.

The committed 26-job recorded example was also exercised as an integrated
offline journey:

```text
node bin/mothbake.mjs validate --config examples/manifest.json
node bin/mothbake.mjs plan --config examples/manifest.json --out /tmp/opencode/mothbake-e2e
node bin/mothbake.mjs run --config examples/manifest.json --out /tmp/opencode/mothbake-e2e
# emitted artifacts removed while raw archives/journal were retained
node bin/mothbake.mjs rebuild --config examples/manifest.json --out /tmp/opencode/mothbake-e2e
node bin/mothbake.mjs inspect --out /tmp/opencode/mothbake-e2e
```

Observed: plan 26 recorded jobs / 0 submissions / 0 estimated credits / 0
unknown-cost jobs; run baked 26 records with 0 failures; rebuild repaired all 26
with 0 failures; journal contained 26 published entries.

### Milestone C

Status: production vertical slice implemented; optional advanced work is listed
in the plan.

- [x] Bounded variation/refinement tests
- [x] Approval pin/supersede tests
- [x] Audio pack exported-byte and transactional publication tests
- [x] Godot source/reference/hash validation with explicit unavailable-runtime record
- [x] Zero-credential end-to-end prepare/approve/rebuild/export journey

```text
node --test test/material-family.test.mjs test/godot.test.mjs
14 passed, 0 failed

node examples/godot/generate.mjs /tmp/opencode/mothbake-godot-example
Godot project emitted and validated; runtime probe: unavailable

node examples/local-first/prepare.mjs /tmp/opencode/mothbake-local-first-check
node examples/local-first/approve.mjs /tmp/opencode/mothbake-local-first-check metal-panel-v01
node examples/local-first/finalize.mjs /tmp/opencode/mothbake-local-first-check
4 candidates prepared; exact plan approved; approved preview hash reproduced;
Godot delivery emitted; no credentials or network; runtime probe unavailable
```

## Live checks deliberately not run

- Authenticated catalog/schema comparison
- Job listing/history reconciliation
- Asset URL refresh
- Job submission, status polling or result retrieval
- Provider-reported backend or billing metadata
- Cancellation (no operation is published in the current OpenAPI schema)

These require separate authorization and, for any submission, an explicit
bounded credit decision. Missing live checks do not block local/fake-service
implementation, but they remain unverified rather than being reported as pass.

## Optional local-evidence batch

```text
node --test test/backends.test.mjs python/mothbake_backends/process.test.mjs \
  test/execution-plan.test.mjs test/cli.test.mjs
37 passed, 0 failed

python3 python/mothbake_backends/test_runner.py
3 passed, 0 failed

node --test test/gc.test.mjs test/media-structure.test.mjs \
  test/candidates.test.mjs test/transactional-pack.test.mjs
23 passed, 0 failed
```

`mothbake backends --json --python /usr/bin/python3` reported the pinned
QuantumBlur backend unavailable because Qiskit/QuantumBlur are not installed;
no installation or real blur execution was attempted. `local-blur --dry`
produced a zero-submission `blocked-local-engine` plan and no output directory.

FFmpeg 7.1.1 generated real local JPEG, WebP, MP3 and Vorbis/Ogg samples; all
four passed their structural validators. This establishes container/framing
coverage, not general codec decodability.

`mothbake gc --dry-run --json` was exercised against the local-first workspace.
It emitted hashes/references/dispositions with `canDelete:false`; a nested
delivery tree without a supported root pointer was conservatively `unknown`,
not unreferenced.

## Final integrated checks

```text
$ npm test
# tests 364
# pass 364
# fail 0
# cancelled 0
# skipped 0

$ find src bin examples -name '*.mjs' -type f | ... node --check
75 JavaScript modules checked successfully
3 Python shim tests passed; Python modules compiled successfully

$ npm pack --dry-run
mothbake-0.1.0.tgz would contain 115 files
package size 1.4 MB; unpacked size 1.9 MB
no tarball was created

$ git diff --check
exit 0
```

The test temporary root is outside `test/`, preventing generated `.mjs` outputs
from racing Node's automatic test discovery.
