# Zero-credit local-first walkthrough

```bash
WORK=/tmp/opencode/mothbake-local-first
# Choose a new/empty path. Never delete an existing evidence workspace merely
# to rerun this example.
node examples/local-first/prepare.mjs "$WORK"
node bin/mothbake.mjs workbench --out "$WORK"
# Inspect the four candidates, note/favorite/reject, and approve one in the UI.
node examples/local-first/finalize.mjs "$WORK"
```

For explicitly authorized automated verification, replace the human approval
step with this **approval mutation**:

```bash
node examples/local-first/approve.mjs "$WORK" metal-panel-v01
```

It refuses an existing approval; replacing one requires deliberate
supersession through the workbench/approval API.

The flow resolves a bounded four-candidate plan, generates a conventional local
baseline and coordinated material families, records exact deltas, approves
content hashes, rebuilds the chosen family from its frozen parameters, verifies
the approved preview hash, and transactionally exports a ready-to-open Godot 4
project. It reads no credential and performs no network or Moth operation.
