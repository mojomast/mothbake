import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
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
  assert.match(stdout, /OK — 26 job\(s\)/);
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

test('JSON mode emits stable validation and error categories', async (t) => {
  const dir = makeTmpDir(t, 'cli-json-errors');
  const file = writeJson(path.join(dir, 'mothbake.json'), { jobs: [{ id: 'bad', engine: 'e', credits: -1 }] });
  const validation = await runCli(['validate', '--config', file, '--json']);
  assert.equal(validation.code, 1);
  const report = JSON.parse(validation.stdout);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((issue) => issue.path.endsWith('credits')));
  const missing = await runCli(['plan', '--config', path.join(dir, 'missing.json'), '--json']);
  assert.equal(missing.code, 1);
  assert.equal(JSON.parse(missing.stderr).error.category, 'operation_failed');
});

test('run --dry plans the recorded jobs without a key or writes', async (t) => {
  const root = makeTmpDir(t, 'cli-dry');
  const outDir = path.join(root, 'not-created');
  const { code, stdout, stderr } = await runCli(['run', '--config', EXAMPLES, '--out', outDir, '--dry']);
  assert.equal(code, 0);
  assert.match(stdout, /dry run — 26 job\(s\): \{"recorded":26\}/);
  assert.match(stderr, /rock-tile \(blur-v1\) — would read the recorded fixture, bake texture-tile/);
  assert.ok(!fs.existsSync(outDir), '--dry must not create the output directory');
});

test('plan and inspect emit stable structured JSON without credentials', async (t) => {
  const outDir = path.join(makeTmpDir(t, 'cli-plan'), 'out');
  const planned = await runCli(['plan', '--config', EXAMPLES, '--out', outDir]);
  assert.equal(planned.code, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout);
  assert.match(plan.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(plan.jobs.length, 26);
  assert.ok(plan.jobs.every((job) => job.action === 'recorded'));
  assert.deepEqual(plan.spending, { submissions: 0, estimatedCredits: 0, unknownCost: 0 });
  assert.ok(!fs.existsSync(outDir));

  const inspected = await runCli(['inspect', '--out', outDir]);
  assert.equal(inspected.code, 0);
  assert.deepEqual(JSON.parse(inspected.stdout), { version: 1, jobs: {} });
});

test('explore resolves a declarative bounded variation request', async (t) => {
  const dir = makeTmpDir(t, 'cli-explore');
  const request = writeJson(path.join(dir, 'variations.json'), {
    version: 1,
    baselineId: 'panel',
    baselineParams: { wear: 0.5 },
    parameters: { wear: { min: 0.4, max: 0.6, steps: 3 } },
  });
  const result = await runCli(['explore', '--request', request]);
  assert.equal(result.code, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.candidates.length, 3);
  assert.match(plan.fingerprint, /^[a-f0-9]{64}$/);
});

test('approve and export require deliberate content-pinned CLI operations', async (t) => {
  const workspace = makeTmpDir(t, 'cli-approve');
  const bytes = readFixture('tile.png');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  fs.mkdirSync(path.join(workspace, 'assets'));
  fs.mkdirSync(path.join(workspace, 'candidates'));
  fs.writeFileSync(path.join(workspace, 'assets', 'source.png'), bytes);
  fs.writeFileSync(path.join(workspace, 'assets', 'result.png'), bytes);
  writeJson(path.join(workspace, 'candidates', 'chosen.json'), {
    version: 1, id: 'chosen', kind: 'image',
    source: { path: 'assets/source.png', sha256 }, result: { path: 'assets/result.png', sha256 },
    params: {}, parameterDelta: {}, backend: 'fixture', provenance: { planFingerprint: createHash('sha256').update('plan').digest('hex') }, qualityReport: {}, favorite: true, rejected: false, notes: '',
  });
  const plan = createHash('sha256').update('plan').digest('hex');
  const approved = await runCli(['approve', '--workspace', workspace, '--candidate', 'chosen', '--plan', plan]);
  assert.equal(approved.code, 0, approved.stderr);
  assert.equal(JSON.parse(approved.stdout).approval.candidateId, 'chosen');
  const exported = await runCli(['export', '--workspace', workspace, '--out', path.join(workspace, 'ship')]);
  assert.equal(exported.code, 0, exported.stderr);
  const result = JSON.parse(exported.stdout);
  assert.ok(fs.existsSync(result.pointer));
  assert.ok(fs.existsSync(path.join(result.directory, 'manifest.json')));
});

test('local backend commands remain explicit and never become hosted submissions', async (t) => {
  const probed = await runCli(['backends', '--json', '--python', '/usr/bin/python3']);
  assert.equal(probed.code, 0, probed.stderr);
  const report = JSON.parse(probed.stdout);
  assert.equal(report.version, 1);
  assert.ok(report.backends.some((backend) => backend.id.startsWith('local:quantumblur:')));
  assert.ok(report.backends.some((backend) => backend.id === 'local:quantumaudio:0.2.0' && backend.implemented === false));

  const outDir = path.join(makeTmpDir(t, 'cli-local-blur-dry'), 'out');
  const dry = await runCli(['local-blur', '--config', path.join(ROOT, 'examples/local-backends/quantumblur.json'), '--out', outDir, '--python', '/usr/bin/python3', '--dry']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).jobs[0].action, 'blocked-local-engine');
  assert.ok(!fs.existsSync(outDir));
});

test('gc is JSON-report-only and refuses deletion', async (t) => {
  const workspace = makeTmpDir(t, 'cli-gc');
  fs.mkdirSync(path.join(workspace, 'assets'));
  fs.writeFileSync(path.join(workspace, 'assets', 'loose.bin'), 'loose');
  const missingFlag = await runCli(['gc', '--out', workspace, '--json']);
  assert.equal(missingFlag.code, 1);
  assert.match(JSON.parse(missingFlag.stderr).error.message, /requires --dry-run/);
  const report = await runCli(['gc', '--out', workspace, '--dry-run', '--json']);
  assert.equal(report.code, 0, report.stderr);
  const parsed = JSON.parse(report.stdout);
  assert.equal(parsed.canDelete, false);
  assert.equal(parsed.entries.find((entry) => entry.path === 'assets/loose.bin').disposition, 'unreferenced');
  const apply = await runCli(['gc', '--out', workspace, '--dry-run', '--apply', '--json']);
  assert.equal(apply.code, 1);
  assert.match(JSON.parse(apply.stderr).error.message, /deletion is not implemented/);
});

test('run --only with an unknown id exits 1 and lists the known ids', async (t) => {
  const outDir = path.join(makeTmpDir(t, 'cli-only'), 'out');
  const { code, stderr } = await runCli(['run', '--config', EXAMPLES, '--only', 'nope', '--out', outDir]);
  assert.equal(code, 1);
  assert.match(stderr, /--only did not match any job: nope/);
  assert.match(stderr, /rock-tile/);

  // A comma-separated list with one valid and one unknown id must fail before
  // running anything, never silently skip the typo.
  const mixed = await runCli(['run', '--config', EXAMPLES, '--only', 'rock-tile,nope', '--out', outDir]);
  assert.equal(mixed.code, 1);
  assert.match(mixed.stderr, /--only did not match any job: nope/);
  assert.ok(!fs.existsSync(outDir), 'a failed --only selection writes nothing');
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
  assert.match(stdout, /wrote 5 source file\(s\)/);
  const rock = decodePng(fs.readFileSync(path.join(outDir, 'rock.png')));
  assert.equal(rock.width, 256);
  assert.equal(rock.height, 256);
  const nebula = decodePng(fs.readFileSync(path.join(outDir, 'nebula.png')));
  assert.equal(nebula.width, 512, 'wide patterns are twice as wide');
  assert.ok(decodeMidi(fs.readFileSync(path.join(outDir, 'motif.mid'))).notes.length > 0);
  assert.ok(fs.existsSync(path.join(outDir, 'bed-seed.wav')), 'audio seeds are generated');
  assert.ok(fs.existsSync(path.join(outDir, 'bed-chunks.zip')), 'chunk archives are generated');
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
  assert.ok(fs.existsSync(path.join(dir, 'lenient', 'raw', 'good', 'inline-result.json')), 'lenient runs continue past a failure');

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
  assert.match(stdout, /baked 26 record\(s\) from 26 job\(s\)/);
  assert.match(stdout, /"textures":1/);
  assert.match(stdout, /"normals":3/);
  assert.match(stdout, /"effects":11/);
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
  for (const effect of ['effect-explosion', 'effect-teleport', 'effect-capture-ring', 'effect-heal', 'effect-shield', 'effect-weather-snow', 'effect-dust', 'effect-flow']) {
    assert.ok(fs.existsSync(path.join(outDir, 'effects', `${effect}.000.png`)), `${effect} frame is written`);
  }
  assert.ok(fs.existsSync(path.join(outDir, 'irs', 'open-air.wav')), 'IR audio is copied next to its descriptor');
  assert.ok(fs.existsSync(path.join(outDir, 'irs', 'open-air.json')), 'IR descriptor is written');
  assert.ok(fs.existsSync(path.join(outDir, 'pack', 'audio', 'bed-ritual.wav')), 'file-mode audio-clip is packed');
  assert.ok(fs.existsSync(path.join(outDir, 'audio', 'bed-stitched.wav')), 'audio-stitch is written');
  assert.ok(fs.existsSync(path.join(outDir, 'spaces', 'arena.json')), 'echo-map sidecar is written');
  assert.ok(fs.existsSync(path.join(outDir, 'pack', 'manifest.json')), 'audio-pack manifest is written');
  const pack = JSON.parse(fs.readFileSync(path.join(outDir, 'pack', 'manifest.json'), 'utf8'));
  assert.ok(pack.clips['audio/bed-ritual']);
  assert.ok(pack.spaces['spaces/arena']);
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
