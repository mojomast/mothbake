# Agent workflows

These recipes keep read-only inspection, local mutation, approval and paid work
separate. Commands are run from the repository root.

## Read-only inspection

```bash
git status --short
node bin/mothbake.mjs validate --config examples/manifest.json --json
node bin/mothbake.mjs plan --config examples/manifest.json --out /tmp/opencode/mothbake-plan
node bin/mothbake.mjs inspect --out /tmp/opencode/mothbake-plan
node bin/mothbake.mjs explore --request <declarative-variation.json>
```

`plan`, `inspect` and `explore` emit JSON. `run --dry` is human-readable text.
Handled `--json` errors are JSON on stderr with exit 1. A plan containing an
unreconciled ambiguous submission exits 2. Inspect executable `.mjs` configs
before loading them.

## Recorded zero-credit run and rebuild

```bash
OUT=/tmp/opencode/mothbake-recorded
node bin/mothbake.mjs run --config examples/manifest.json --out "$OUT"
node bin/mothbake.mjs rebuild --config examples/manifest.json --out "$OUT"
node bin/mothbake.mjs inspect --out "$OUT"
```

Recorded fixtures prove the local pipeline, not current live-engine
compatibility. Rebuild verifies archived bytes before rerunning local bakers.

## Candidate review, approval and export

```bash
WORK=/tmp/opencode/mothbake-local-first-new
# WORK must be new/empty; do not delete an existing workspace automatically.
node examples/local-first/prepare.mjs "$WORK"
node bin/mothbake.mjs workbench --out "$WORK"
# Human reviews candidates and approves one in the loopback UI.
node examples/local-first/finalize.mjs "$WORK"
```

For explicitly authorized automated verification only:

```bash
node examples/local-first/approve.mjs "$WORK" metal-panel-v01
```

CLI `export --workspace "$WORK"` creates a generic approved pack under
`delivery/.versions/`; `finalize.mjs` creates a Godot project under
`delivery/godot/versions/`. Resolve each adjacent `current.json`. Approval and
supersession are mutations; preparing or favoriting a candidate is not approval.

## Optional local QuantumBlur

Read-only probe and plan:

```bash
node bin/mothbake.mjs backends --json --python /absolute/path/to/python
node bin/mothbake.mjs local-blur \
  --config examples/local-backends/quantumblur.json \
  --out /tmp/opencode/mothbake-qb \
  --python /absolute/path/to/python \
  --dry
```

Installing the optional environment or executing it requires authorization:

```bash
python3 -m venv .venv-local
.venv-local/bin/python -m pip install \
  -r python/mothbake_backends/requirements-quantumblur.txt
node bin/mothbake.mjs local-blur \
  --config examples/local-backends/quantumblur.json \
  --out /tmp/opencode/mothbake-qb \
  --python .venv-local/bin/python
```

This is a pinned local backend, not Atlas blur. Ordinary `run` blocks all
`local:` engines. Quantum Audio remains deferred and is not `qrc-audio-v1`.

## Read-only evidence/GC report

```bash
node bin/mothbake.mjs gc --out <workspace> --dry-run --json
```

Unknown/corrupt/unsupported state stays `unknown`. “Unreferenced” is bounded to
the supported roots; it is not deletion permission. `--apply` is refused.

## Authenticated discovery and live work — explicit gate

Only with authorization for account-safe GETs:

```bash
MOTH_API_KEY=... node bin/mothbake.mjs catalog \
  --snapshot contracts/moth-YYYY-MM-DD.json
node bin/mothbake.mjs validate --config mothbake.json --json
node bin/mothbake.mjs plan --config mothbake.json --out mothbake-out > /tmp/opencode/plan.json
```

Review the complete plan, costs, unknowns, input hashes and affected approvals.
Only after the owner approves its exact fingerprint:

```bash
MOTH_API_KEY=... node bin/mothbake.mjs run \
  --config mothbake.json --out mothbake-out \
  --approve-spend <exact-plan-fingerprint>
```

Never use `--force` to escape `submitting`, `unknown-submission`, a recipe
conflict or an immutable-archive conflict. Stop and reconcile manually.

## Change verification

Run relevant focused tests first. Then run the complete offline suite and
packaging checks from `AGENTS.md`. If Chromium, Godot, FFmpeg, QuantumBlur,
credentials or a live account are unavailable, say so; do not convert source
inspection into a runtime pass.
