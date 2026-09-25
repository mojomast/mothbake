# Local QuantumBlur workflow (opt-in)

This example describes the boundary for a local QuantumBlur result. Install the
optional dependencies in
`python/mothbake_backends/requirements-quantumblur.txt` in a
dedicated environment, verify `probeQuantumBlur({python: '/absolute/path'})`,
then call `runQuantumBlur({grid, xi, locality, axis}, {python})`. It produces an
inline `{output, provenance}` value. Archive that result using the existing
inline-result workflow; the archived artifact can then pass through the normal
repair and baker flow.

```bash
node bin/mothbake.mjs backends --json --python .venv-local/bin/python
node bin/mothbake.mjs local-blur \
  --config examples/local-backends/quantumblur.json \
  --out /tmp/opencode/mothbake-qb \
  --python .venv-local/bin/python
node bin/mothbake.mjs rebuild \
  --config examples/local-backends/quantumblur.json \
  --out /tmp/opencode/mothbake-qb
```

No hosted engine, network, hardware or MicroMoth fallback is involved. The
backend is Apache-2.0 QuantumBlur pinned to
`cecdf5faf08e847c41f5b0aeea923e15803875e8`; preserve upstream IBM attribution
and license notices when installing/distributing upstream source.

The config authoring alias is `engine: "local:quantumblur"`; archived and
emitted provenance uses the exact pinned `local:quantumblur:<commit>` identity.
`runQuantumBlur()` itself returns `{ output, provenance }`. The `local-blur` CLI
adds journal/archive/rebuild behavior. Run with `--dry` before optional
installation or execution to confirm that the plan contains zero Moth
submissions.
