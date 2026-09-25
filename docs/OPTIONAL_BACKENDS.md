# Optional local backend research

Checked: 2026-09-25

No optional backend is silently substituted for a hosted Moth engine. These
libraries are Python/quantum capabilities with different contracts, dependency
weight and semantics from Atlas engines.

## QuantumBlur

Official source: <https://github.com/qiskit-community/QuantumBlur>

- Apache-2.0 licensed.
- The upstream repository was archived read-only on 2026-09-11.
- It operates on height maps/images and supports either a Qiskit/NumPy/SciPy/PIL
  path or a lightweight MicroMoth path.
- Moth also maintains a C# fork oriented toward Godot/Unity, but that does not
  make either implementation byte- or contract-equivalent to `blur-v1` or
  `blur-core-v1` on Atlas.

The implemented opt-in adapter is an isolated, bounded subprocess pinned to
commit `cecdf5faf08e847c41f5b0aeea923e15803875e8`. It reports dependency
versions, accepts bounded numeric grids, archives under the distinct
`local:quantumblur:<commit>` identity, explicitly rejects MicroMoth fallback and
can never fall through to billable Atlas. See `docs/LOCAL_BACKENDS.md`.

## Quantum Audio

Official source: <https://github.com/moth-quantum/quantum-audio>

- Apache-2.0 licensed; current public documentation identifies Quantum Audio
  0.2.0 and a Python/Qiskit implementation.
- It encodes and decodes digital audio as quantum circuits through schemes such
  as QPAM, SQPAM, MSQPAM, QSM and MQSM.
- It is **not** a general text-to-sound generator and is not a drop-in local
  implementation of Atlas `qrc-audio-v1`. The latter's documented contract
  sequences supplied audio/chunks using a trained/reused reservoir and returns
  audio/model/state outputs.

A future adapter needs an availability probe, version/license report, bounded
audio dimensions, deterministic simulator fixtures, explicit scheme selection,
and separate preview/export quality gates. Heavy Qiskit/Python dependencies stay
optional and outside Mothbake's core installation.

## Current decision

The production local vertical slice now includes an **opt-in QuantumBlur
adapter** pinned to the audited commit, while npm/CI remain Python-free. Its real
runtime is unavailable in the implementation environment and therefore not
claimed as validated. Quantum Audio remains deferred and is surfaced honestly
as an unimplemented codec-roundtrip capability, not `qrc-audio-v1`.

See [LOCAL_BACKENDS.md](LOCAL_BACKENDS.md).
