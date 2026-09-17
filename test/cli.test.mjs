import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { decodeMidi, decodePng } from '../src/decoders/index.mjs';
import { makeTmpDir, readFixture, ROOT, runCli, writeJson } from './helpers.mjs';

const EXAMPLES = path.join(ROOT, 'examples', 'manifest.json');

test('--help prints usage and exits 0', async () => {
  const { code, stdout } = await runCli(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /Usage:/);
  assert.match(stdout, /mothbake <command> \[options\]/);
  assert.match(stdout, /Bakers: texture-tile, sky/);
});

test('--version prints the package version', async () => {
  const { code, stdout } = await runCli(['--version']);
  assert.equal(code, 0);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('unknown commands and options exit 1 with a hint', async () => {
  const command = await runCli(['frobnicate']);
  assert.equal(command.code, 1);
  assert.match(command.stderr, /unknown command "frobnicate"/);
  const option = await runCli(['run', '--wat']);
  assert.equal(option.code, 1);
  assert.match(option.stderr, /unknown option: --wat/);
  const missing = await runCli(['run', '--config']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /--config needs a value/);
});

test('validate accepts the example manifest', async () => {
  const { code, stdout, stderr } = await runCli(['validate', '--config', EXAMPLES]);
  assert.equal(code, 0);
  assert.match(stdout, /OK — 18 job\(s\)/);
  assert.equal(stderr, '');
});

test('validate reports every problem and exits 1', async (t) => {
  const dir = makeTmpDir(t, 'cli-validate');
  const file = writeJson(path.join(dir, 'mothbake.json'), {
    jobs: [
      { id: 'bad', engine: 'blur-v1', bake: { type: 'nope' } },
      { id: 'bad', engine: 'blur-v1' },
    ],
  });
  const { code, stderr } = await runCli(['validate', '--config', file]);
  assert.equal(code, 1);
  assert.match(stderr, /error: jobs\[0\]\.bake\.type: unknown baker "nope"/);
  assert.match(stderr, /error: jobs\[1\]\.id: duplicate job id "bad"/);
  assert.match(stderr, /2 error\(s\) in/);
});

test('run --dry plans the recorded jobs without a key or writes', async (t) => {
  const root = makeTmpDir(t, 'cli-dry');
  const outDir = path.join(root, 'not-created');
  const { code, stdout, stderr } = await runCli(['run', '--config', EXAMPLES, '--out', outDir, '--dry']);
  assert.equal(code, 0);
  assert.match(stdout, /dry run — 18 job\(s\): \{"recorded":18\}/);
  assert.match(stderr, /rock-tile \(blur-v1\) — would read the recorded fixture, bake texture-tile/);
  assert.ok(!fs.existsSync(outDir), '--dry must not create the output directory');
});

test('run --only with an unknown id exits 1 and lists the known ids', async (t) => {
  const outDir = path.join(makeTmpDir(t, 'cli-only'), 'out');
  const { code, stderr } = await runCli(['run', '--config', EXAMPLES, '--only', 'nope', '--out', outDir]);
  assert.equal(code, 1);
  assert.match(stderr, /--only did not match any job: nope/);
  assert.match(stderr, /rock-tile/);
});

test('catalog requires MOTH_API_KEY', async () => {
  const { code, stderr } = await runCli(['catalog']);
  assert.equal(code, 1);
  assert.match(stderr, /MOTH_API_KEY is not set/);
});

test('sources writes the patterns the jobs need plus a motif', async (t) => {
  const outDir = path.join(makeTmpDir(t, 'cli-sources'), 'generated');
  const { code, stdout } = await runCli(['sources', '--config', EXAMPLES, '--out', outDir]);
  assert.equal(code, 0);
  assert.match(stdout, /wrote 3 source file\(s\)/);
  const rock = decodePng(fs.readFileSync(path.join(outDir, 'rock.png')));
  assert.equal(rock.width, 256);
  assert.equal(rock.height, 256);
  const nebula = decodePng(fs.readFileSync(path.join(outDir, 'nebula.png')));
  assert.equal(nebula.width, 512, 'wide patterns are twice as wide');
  assert.ok(decodeMidi(fs.readFileSync(path.join(outDir, 'motif.mid'))).notes.length > 0);
  assert.ok(!fs.existsSync(path.join(outDir, 'macro.png')), 'unreferenced patterns are skipped');
});

test('run --strict stops at the first failed job', async (t) => {
  const dir = makeTmpDir(t, 'cli-strict');
  const file = writeJson(path.join(dir, 'mothbake.json'), {
    jobs: [
      { id: 'broken', engine: 'blur-v1', recorded: { outputs: { result: './missing.png' } } },
      { id: 'good', engine: 'blur-v1', recorded: { result: { ok: true } } },
    ],
  });

  const lenient = await runCli(['run', '--config', file, '--out', path.join(dir, 'lenient')]);
  assert.equal(lenient.code, 1);
  assert.match(lenient.stderr, /failed: broken/);
  assert.ok(fs.existsSync(path.join(dir, 'lenient', 'raw', 'good', 'result.json')), 'lenient runs continue past a failure');

  const strict = await runCli(['run', '--config', file, '--out', path.join(dir, 'strict'), '--strict']);
  assert.equal(strict.code, 1);
  assert.match(strict.stderr, /mothbake: recorded output "result" not found/);
  assert.ok(!strict.stderr.includes('failed: broken'), 'strict mode aborts before the failure summary');
  assert.ok(!fs.existsSync(path.join(dir, 'strict', 'raw', 'good', 'result.json')), 'strict mode stops before later jobs');
});

test('run completes an offline recorded bake through the CLI', async (t) => {
  const outDir = path.join(makeTmpDir(t, 'cli-run'), 'out');
  const before = fs.readFileSync(EXAMPLES, 'utf8');
  const { code, stdout, stderr } = await runCli(['run', '--config', EXAMPLES, '--out', outDir]);
  assert.equal(code, 0, stderr);
  assert.match(stdout, /baked 18 record\(s\) from 18 job\(s\)/);
  assert.match(stdout, /"textures":1/);
  assert.match(stdout, /"effects":9/);
  assert.ok(fs.existsSync(path.join(outDir, 'baked.mjs')));
  assert.ok(fs.existsSync(path.join(outDir, 'textures', 'rock.png')));
  assert.ok(fs.existsSync(path.join(outDir, 'raw', 'rock-tile', 'result.png')));
  assert.deepEqual(
    fs.readFileSync(path.join(outDir, 'textures', 'rock.png')).length > 0,
    true,
  );
  assert.equal(fs.readFileSync(path.join(outDir, 'raw', 'rock-tile', 'result.png')).length, readFixture('tile.png').length);
  assert.ok(fs.existsSync(path.join(outDir, 'sprites', 'walk.png')), 'sprite-sheet atlas is written');
  assert.ok(fs.existsSync(path.join(outDir, 'sprites', 'walk.json')), 'atlas emitter writes the sidecar');
  assert.ok(fs.existsSync(path.join(outDir, 'audio', 'footstep.wav')), 'audio-clip WAV is written');
  for (const effect of ['effect-explosion', 'effect-teleport', 'effect-capture-ring', 'effect-heal', 'effect-shield', 'effect-weather-snow']) {
    assert.ok(fs.existsSync(path.join(outDir, 'effects', `${effect}.000.png`)), `${effect} frame is written`);
  }
  assert.ok(fs.existsSync(path.join(outDir, 'irs', 'open-air.wav')), 'IR audio is copied next to its descriptor');
  assert.ok(fs.existsSync(path.join(outDir, 'irs', 'open-air.json')), 'IR descriptor is written');
  assert.equal(fs.readFileSync(EXAMPLES, 'utf8'), before, 'recorded-only runs must not rewrite the config');
});

test('run --only runs a single job offline', async (t) => {
  const outDir = path.join(makeTmpDir(t, 'cli-run-one'), 'out');
  const { code, stdout } = await runCli(['run', '--config', EXAMPLES, '--out', outDir, '--only', 'rock-tile']);
  assert.equal(code, 0);
  assert.match(stdout, /baked 1 record\(s\) from 1 job\(s\)/);
  assert.ok(fs.existsSync(path.join(outDir, 'textures', 'rock.png')));
  assert.ok(!fs.existsSync(path.join(outDir, 'sky')), 'only the selected job should bake');
});
