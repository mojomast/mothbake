import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ConfigError, DEFAULT_CONFIG_FILES, assertValidConfig, findConfigFile, formatIssue, loadConfig, validateConfig } from '../src/config.mjs';
import { makeTmpDir, ROOT } from './helpers.mjs';

const baseJob = (overrides = {}) => ({
  id: 'tile',
  engine: 'blur-v1',
  inputs: { image: 'sources/rock.png' },
  params: { strength: 0.5 },
  raw: 'tile',
  bake: { type: 'texture-tile', name: 'rock', size: 64 },
  ...overrides,
});

const errorsOf = (config, options) => validateConfig(config, options).errors.map(formatIssue);

test('loadConfig reads the example JSON manifest', async () => {
  const loaded = await loadConfig({ file: path.join(ROOT, 'examples', 'manifest.json') });
  assert.equal(loaded.format, 'json');
  assert.equal(loaded.config.jobs.length, 7);
  assert.equal(loaded.dir, path.join(ROOT, 'examples'));
  assert.deepEqual(validateConfig(loaded.config).errors, []);
});

test('loadConfig imports a module config with custom functions', async (t) => {
  const dir = makeTmpDir(t, 'config-mjs');
  const file = path.join(dir, 'mothbake.config.mjs');
  fs.writeFileSync(
    file,
    `export const bakers = { 'my-baker': () => ({ bucket: 'x', key: 'y', value: 1 }) };
export const generators = { flat: (spec) => [[spec.size]] };
export default { jobs: [{ id: 'a', engine: 'blur-v1', bake: { type: 'my-baker' }, generateValues: { type: 'flat', size: 2 } }] };
`,
  );
  const loaded = await loadConfig({ file });
  assert.equal(loaded.format, 'module');
  assert.equal(loaded.config.jobs[0].id, 'a');
  const { errors } = validateConfig(loaded.config, { bakers: ['my-baker'], generators: ['flat'] });
  assert.deepEqual(errors, []);
});

test('loadConfig reports missing and broken files clearly', async (t) => {
  const dir = makeTmpDir(t, 'config-broken');
  await assert.rejects(() => loadConfig({ cwd: dir }), new RegExp(`no config found in .*${path.basename(dir)}`));
  await assert.rejects(() => loadConfig({ file: path.join(dir, 'nope.json') }), /config not found/);
  const badJson = path.join(dir, 'mothbake.json');
  fs.writeFileSync(badJson, '{ nope');
  await assert.rejects(() => loadConfig({ file: badJson }), /invalid JSON/);
  const badModule = path.join(dir, 'mothbake.config.mjs');
  fs.writeFileSync(badModule, 'export const nope = 1;\n');
  await assert.rejects(() => loadConfig({ file: badModule }), /default export must be a config object/);
});

test('findConfigFile prefers the module config', (t) => {
  const dir = makeTmpDir(t, 'config-find');
  assert.equal(findConfigFile(dir), null);
  fs.writeFileSync(path.join(dir, 'mothbake.json'), '{}');
  assert.equal(path.basename(findConfigFile(dir)), 'mothbake.json');
  fs.writeFileSync(path.join(dir, 'mothbake.config.mjs'), 'export default {};');
  assert.equal(path.basename(findConfigFile(dir)), DEFAULT_CONFIG_FILES[0]);
});

test('validateConfig accepts a well-formed config without warnings', () => {
  const { errors, warnings } = validateConfig({
    version: 1,
    baseUrl: 'https://example.test',
    jobs: [
      baseJob(),
      baseJob({ id: 'grid', engine: 'blur-core-v1', inputs: undefined, generateValues: { type: 'height', size: 32 }, bake: { type: 'normal-map', name: 'rock', size: 32 } }),
      baseJob({ id: 'frames', engine: 'blur-core-v1', inputs: undefined, generateValues: { type: 'radial', frame: 1 }, bake: { type: 'effect-frame', name: 'rift', index: 1, fps: 10, tint: 'ember' } }),
    ],
    sources: { dir: 'sources', patterns: { rock: { size: 256 } }, motif: false },
    emitters: [{ type: 'files' }, { type: 'esm', file: 'baked.mjs', export: 'BAKED' }],
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('validateConfig reports every problem with a path', () => {
  const errors = errorsOf({
    jobs: [
      { id: 'dup', engine: 'blur-v1' },
      { id: 'dup', engine: 'blur-v1' },
      { id: 'bad', engine: '' },
      { id: 'bake', engine: 'blur-v1', bake: { type: 'nope', size: 0 } },
      { id: 'gen', engine: 'blur-v1', generateValues: { type: 'vibes' } },
      { id: 'inputs', engine: 'blur-v1', inputs: { image: 42 } },
      { id: 'rec', engine: 'blur-v1', recorded: {} },
    ],
    emitters: [{ type: 'nope' }],
    baseUrl: '',
  });
  assert.equal(errors.length, 9, errors.join('\n'));
  assert.ok(errors.some((line) => line.startsWith('jobs[1].id: duplicate job id "dup"')));
  assert.ok(errors.some((line) => line.startsWith('jobs[2].engine: engine must be a non-empty string')));
  assert.ok(errors.some((line) => line.includes('unknown baker "nope"')));
  assert.ok(errors.some((line) => line.includes('bake.size must be a positive integer')));
  assert.ok(errors.some((line) => line.includes('unknown generator "vibes"')));
  assert.ok(errors.some((line) => line.startsWith('jobs[5].inputs.image: input path')));
  assert.ok(errors.some((line) => line.startsWith('jobs[6].recorded: recorded needs at least one')));
  assert.ok(errors.some((line) => line.startsWith('emitters[0].type: unknown emitter "nope"')));
  assert.ok(errors.some((line) => line.startsWith('baseUrl:')));
});

test('validateConfig requires jobs and warns about unknown keys', () => {
  const { errors, warnings } = validateConfig({ jobs: 'nope', extra: true, jobsTypo: [] });
  assert.ok(errors.some((issue) => issue.path === 'jobs'));
  assert.ok(warnings.some((issue) => issue.path === 'extra'));
  const jobWarnings = validateConfig({ jobs: [{ ...baseJob(), typo: 1 }] }).warnings;
  assert.ok(jobWarnings.some((issue) => issue.path === 'jobs[0].typo' && issue.message.includes('unknown job key')));
  const bakeWarnings = validateConfig({ jobs: [{ ...baseJob(), bake: { type: 'texture-tile', wat: 1 } }] }).warnings;
  assert.ok(bakeWarnings.some((issue) => issue.path === 'jobs[0].bake.wat'));
});

test('validateConfig accepts both input and inputs, preferring inputs', () => {
  const { warnings } = validateConfig({ jobs: [baseJob({ input: { image: 'a.png' }, inputs: { image: 'b.png' } })] });
  assert.ok(warnings.some((issue) => issue.message.includes('"inputs" wins')));
});

test('assertValidConfig throws a ConfigError carrying the issues', () => {
  try {
    assertValidConfig({ jobs: [{ id: 'x', engine: 'blur-v1', bake: { type: 'nope' } }] });
    assert.fail('expected a ConfigError');
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    assert.equal(error.issues.length, 1);
    assert.match(error.message, /invalid config/);
    assert.match(error.message, /jobs\[0\]\.bake\.type/);
  }
});

test('validateConfig widens the known type lists for custom registries', () => {
  const config = { jobs: [{ id: 'x', engine: 'e', bake: { type: 'mine' }, generateValues: { type: 'flat' } }], bakers: { mine: () => {} }, generators: { flat: () => [] } };
  const { errors } = validateConfig(config, { bakers: ['texture-tile', 'mine'], generators: ['height', 'flat'], emitters: ['files'] });
  assert.deepEqual(errors, []);
  const broken = validateConfig({ ...config, bakers: { mine: 42 }, generators: { flat: 'no' } });
  assert.ok(broken.errors.some((issue) => issue.path === 'bakers.mine'));
  assert.ok(broken.errors.some((issue) => issue.path === 'generators.flat'));
});
