# Optional local backends

Checked: 2026-09-25

Local backends are explicit, optional subprocess capabilities. They never read
`MOTH_API_KEY`, call Atlas, or silently fall back to a hosted engine.

## QuantumBlur

Implemented backend identity:

```text
local:quantumblur:cecdf5faf08e847c41f5b0aeea923e15803875e8
```

The adapter targets the official archived Apache-2.0 source at that exact
commit: <https://github.com/qiskit-community/QuantumBlur>. It retains a separate
notice under `python/mothbake_backends/QUANTUMBLUR-NOTICE.md`; upstream code is
not vendored.

### Install explicitly

```bash
python3 -m venv .venv-local
.venv-local/bin/python -m pip install \
  -r python/mothbake_backends/requirements-quantumblur.txt
```

Core npm installation and CI remain dependency-free. The optional environment
contains Qiskit, Aer, NumPy, SciPy and Pillow.

### Probe and run

```bash
node bin/mothbake.mjs backends --json \
  --python .venv-local/bin/python

node bin/mothbake.mjs local-blur \
  --config examples/local-backends/quantumblur.json \
  --out /tmp/opencode/mothbake-qb \
  --python .venv-local/bin/python

node bin/mothbake.mjs rebuild \
  --config examples/local-backends/quantumblur.json \
  --out /tmp/opencode/mothbake-qb
```

`local-blur` freezes the existing Mothbake recipe identity, runs only the pinned
local subprocess, archives the inline grid with `verification: local-backend`,
then invokes the normal offline bakers/emitters. A repeated matching archive is
reused. A mismatched raw name is refused rather than overwritten.

Limits are 4,096 cells, 20 coordinate qubits, a 1 MiB request, 4 MiB combined
response, and at most 120 seconds. Inputs must be rectangular, nonzero and in
`[0,1]`. The subprocess receives a minimal environment, has bounded pipes, and
is killed on timeout/abort. MicroMoth fallback is explicitly rejected.

### Honest boundary

QuantumBlur is not `blur-v1` or `blur-core-v1`. Its parameters, normalization,
image handling and implementation differ. Provenance always names the local
commit identity; it is not labelled as Atlas, hardware execution or quantum
advantage. Determinism is only claimed for a fixed dependency/backend set.

The implementation environment does not contain QuantumBlur/Qiskit, so the
real probe reports `available:false`. JavaScript and Python protocol tests use
offline fixtures; an actual blur run remains unverified until the optional
environment is installed intentionally.

## Moth Quantum Audio

The static backend report lists `local:quantumaudio:0.2.0` as **deferred**.
Official Quantum Audio is a Python/Qiskit audio-to-circuit codec, not Atlas
`qrc-audio-v1`'s reservoir sequencer or text-to-sound generation. Its default
decode is shot-random and it carries Apache-2.0 plus NOTICE attribution.

No runtime adapter was added because its near-term production value is lower
and its semantics are easy to misrepresent. A future adapter must be called an
audio codec round-trip, expose scheme/shots explicitly, preserve the upstream
NOTICE, use a separate identity, and never fall back to `qrc-audio-v1`.
