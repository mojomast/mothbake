# Mothbake agent instructions

These instructions apply to the whole repository.

## Start safely

1. Run `git status --short`, note the current branch and preserve unrelated
   changes. Never reset, clean, force-push, publish, release or push without
   explicit authorization.
2. Read `README.md`, `docs/ARCHITECTURE.md`,
   `docs/moth-api-contract.md` and the relevant example before editing.
3. Treat `.mjs` configs as **trusted executable code**. Inspect one before
   loading it. Imported/browser recipes must stay declarative JSON.
4. Default to recorded fixtures, local generators, fake APIs and archived
   results. Ordinary tests must be offline and zero-credit.

## Spending and remote operations

- Never read or print credentials unless the user explicitly authorizes the
  exact operation. Do not log bearer headers, signed URLs or raw private errors.
- `credits` in a manifest is an estimate. Requested `mode` is not proof of the
  actual backend or billing.
- Before any live submission: validate against a dated contract snapshot,
  inspect `mothbake plan`, obtain approval for that exact plan fingerprint and
  budget, then use `--approve-spend <fingerprint>`.
- `--force` means fresh intent; it is **not** spending approval and must not be
  used to resolve an ambiguous request.
- `submitting`/`unknown-submission` journal states require manual job-history and
  billing reconciliation. Never retry automatically.
- `local:` engines never go to Moth. Use the explicit local command. Optional
  backends may be unavailable; never install them or fall back to cloud without
  authorization.

## Evidence and approvals

- Preserve provider raw bytes separately from processed outputs. New raw
  archives are immutable and hash-verified; legacy archives are unverified.
- Fixture tests establish local behavior only. Structural media checks are not
  full decoding. Source/reference checks are not a Godot runtime import.
- Candidate approval and supersession are mutations. A rejected candidate
  cannot be approved. Approval pins exact content and a candidate-bound plan.
- `gc` is report-only. `canDelete` is always false and `--apply` is refused.
  “Unreferenced” only means no reference was found inside the bounded scan.
- Keep simulator/local/backend claims distinct. Do not claim hardware execution,
  Atlas equivalence, quantum advantage or cross-version byte determinism without
  evidence.

## Implementation rules

- Preserve Node ESM, zero core dependencies and the existing CLI/API where
  practical. Heavy tools remain optional.
- CLI and UI must share core validation, planning, approval and export logic.
- Confine filesystem reads/writes to configured roots; reject traversal,
  symlink escapes, oversized inputs and unsafe archives.
- Keep pack publication transactional. A failed build must not replace the
  current pointer; retain completed versions for rollback.
- Use explicit backend identities such as `local:quantumblur:<commit>`. Quantum
  Audio is a deferred codec round-trip, not `qrc-audio-v1`.

## Verification

Run focused tests for changed areas, then:

```bash
npm test
git diff --check
for f in $(find src bin examples python -name '*.mjs' -type f); do node --check "$f"; done
python3 python/mothbake_backends/test_runner.py
npm pack --dry-run
```

Do not report tests or runtime/live compatibility you did not actually verify.
Record unavailable optional runtimes separately from failures and passes. See
`docs/AGENT_WORKFLOWS.md` for executable safe workflows.
