# Opt-in local QuantumBlur shim

This directory adds no core runtime dependency. The adapter accepts only an
explicit Qiskit-path install of the official Apache-2.0 QuantumBlur source at
commit `cecdf5faf08e847c41f5b0aeea923e15803875e8`:

```sh
python3 -m venv .venv-local
.venv-local/bin/python -m pip install 'git+https://github.com/qiskit-community/QuantumBlur.git@cecdf5faf08e847c41f5b0aeea923e15803875e8'
.venv-local/bin/python -m pip install scipy
```

The user supplies the absolute interpreter path to `runPythonBackend`; it
never installs packages or contacts a service. For example, call
`runPythonBackend({operation: 'probe'}, {python: '/absolute/path/to/python'})`.
The probe reports package versions, Python version, license, and exact backend
identity. `available: false` means the pinned install or required packages
could not be verified. `blur` accepts only `{operation:'blur', width, height,
values, xi}`: a row-major, nonzero rectangular grid of values in `[0,1]`,
bounded as described below, and blur rotation fraction `xi` in `[0,1]`.
It returns a normalized grid and provenance. This is not equivalent to any
hosted Atlas blur engine, and is never used as a silent fallback.

The Node bridge launches isolated Python (`-I`) without inherited credentials,
with bounded stdin, stdout/stderr and deadline. The runner handles one JSON
request on stdin and one JSON object on stdout. Grids are bounded to 4096 cells
and 20 coordinate qubits; non-power-of-two rectangles supported by the pinned
upstream API are allowed. No filesystem input paths,
network operations or hardware backend are supported.
