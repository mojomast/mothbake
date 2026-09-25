import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { decodePng } from '../src/decoders/png.mjs';
import { createMaterialFamily } from '../src/material-family.mjs';
import {
  exportGodotMaterialFamily, readCurrentGodotPack, rollbackGodotMaterialFamily,
  validateGodotPack, probeGodotPack,
} from '../src/emitters/godot.mjs';

const names = ['color', 'height', 'normal', 'roughness', 'wear'];
const sample = (value = 128) => ({ width: 2, height: 2, maps: Object.fromEntries(names.map((name) =>
  [name, { width: 2, height: 2, data: new Uint8Array(16).fill(value) }])), metadata: { source: 'test' } });
const temp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'godot-pack-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('pack is a self-contained Godot project with hashed files, valid references and color semantics', (t) => {
  const root = temp(t);
  const result = exportGodotMaterialFamily(sample(), root);
  const { projectDir, manifest, version } = readCurrentGodotPack(root);
  assert.equal(result.version, version);
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(validateGodotPack(projectDir), manifest);
  for (const [file, entry] of Object.entries(manifest.files)) {
    const bytes = fs.readFileSync(path.join(projectDir, file));
    assert.equal(entry.sha256, hash(bytes));
    assert.equal(entry.bytes, bytes.length);
  }
  for (const name of names) {
    assert.equal(decodePng(fs.readFileSync(path.join(projectDir, manifest.maps[name].file))).width, 2);
    assert.equal(manifest.maps[name].colorSpace, name === 'color' ? 'sRGB' : 'linear');
  }
  assert.match(manifest.maps.normal.interpretation, /OpenGL \(\+Y\)/);
  assert.match(manifest.maps.wear.interpretation, /heuristic/);
  const tres = fs.readFileSync(path.join(projectDir, 'material.tres'), 'utf8');
  const scene = fs.readFileSync(path.join(projectDir, 'demo.tscn'), 'utf8');
  for (const ref of [...tres.matchAll(/path="(res:\/\/[^"\n]+)"/g), ...scene.matchAll(/path="(res:\/\/[^"\n]+)"/g)]) {
    assert.ok(fs.existsSync(path.join(projectDir, ref[1].slice(6))));
  }
  assert.match(tres, /roughness_texture_channel = 0/);
  assert.match(tres, /heightmap_enabled = true/);
  assert.match(tres, /heightmap_texture = ExtResource\("4_height"\)/);
  assert.match(scene, /name="Sphere"/);
  assert.match(fs.readFileSync(path.join(projectDir, 'project.godot'), 'utf8'), /run\/main_scene="res:\/\/demo.tscn"/);
});

test('failed staging, manifest and promotion leave current unchanged; rollback restores prior version', (t) => {
  const root = temp(t);
  const first = exportGodotMaterialFamily(sample(), root);
  const pointer = fs.readFileSync(path.join(root, 'current.json'));
  for (const step of ['files', 'manifest', 'promotion']) {
    assert.throws(() => exportGodotMaterialFamily(sample(200), root, {
      onStage(stage) { if (stage === step) throw new Error(`failed ${step}`); },
    }), new RegExp(`failed ${step}`));
    assert.deepEqual(fs.readFileSync(path.join(root, 'current.json')), pointer);
    assert.equal(readCurrentGodotPack(root).version, first.version);
  }
  const second = exportGodotMaterialFamily(sample(200), root);
  assert.notEqual(second.version, first.version);
  assert.equal(rollbackGodotMaterialFamily(root, first.version).version, first.version);
  assert.equal(readCurrentGodotPack(root).version, first.version);
  assert.equal(rollbackGodotMaterialFamily(root, second.version).version, second.version);
  assert.throws(() => rollbackGodotMaterialFamily(root, '../escape'), /invalid version/);
});

test('rejects malformed maps, symlink escapes and corrupt versions', (t) => {
  const root = temp(t);
  const bad = sample();
  bad.maps.normal.data = new Uint8Array(2);
  assert.throws(() => exportGodotMaterialFamily(bad, root), /normal RGBA/);
  const outside = temp(t);
  fs.symlinkSync(outside, path.join(root, 'versions'));
  assert.throws(() => exportGodotMaterialFamily(sample(), root), /unsafe directory/);
  fs.unlinkSync(path.join(root, 'versions'));
  const one = exportGodotMaterialFamily(sample(), root);
  fs.writeFileSync(path.join(one.projectDir, 'material.tres'), 'corrupt');
  assert.throws(() => validateGodotPack(one.projectDir), /hash mismatch/);
  assert.throws(() => rollbackGodotMaterialFamily(root, one.version), /hash mismatch/);
});

test('rejects symlinked root and dangling pointer without touching their targets', (t) => {
  const root = temp(t);
  const target = temp(t);
  const linked = path.join(root, 'link');
  fs.symlinkSync(target, linked);
  assert.throws(() => exportGodotMaterialFamily(sample(), linked), /unsafe directory/);
  fs.symlinkSync(path.join(target, 'missing.json'), path.join(root, 'current.json'));
  assert.throws(() => exportGodotMaterialFamily(sample(), root), /unsafe file/);
  assert.deepEqual(fs.readdirSync(target), []);
});

test('optional Godot probe reports unavailable for absent executable', (t) => {
  const pack = exportGodotMaterialFamily(sample(), temp(t));
  assert.deepEqual(probeGodotPack(pack.projectDir, { executable: '__missing_godot_binary__' }), { status: 'unavailable' });
});

test('real local material family exports cleanly and carries heuristic labels', (t) => {
  const family = createMaterialFamily({ width: 24, height: 18, seed: 17 });
  const pack = exportGodotMaterialFamily(family.candidate, temp(t));
  assert.equal(pack.manifest.width, 24);
  assert.match(pack.manifest.maps.roughness.interpretation, /synthesis heuristic; not recovered physical truth/);
  assert.match(pack.manifest.maps.wear.interpretation, /synthesis heuristic; not recovered physical truth/);
  assert.equal(pack.manifest.metadata.normalConvention, 'OpenGL +Y');
  for (const name of names) {
    const image = decodePng(fs.readFileSync(path.join(pack.projectDir, pack.manifest.maps[name].file)));
    assert.deepEqual(image.data, family.candidate.maps[name].data);
  }
});

test('validation refuses a textures symlink even if it points to complete PNGs', (t) => {
  const root = temp(t);
  const pack = exportGodotMaterialFamily(sample(), root);
  const other = path.join(root, 'outside');
  fs.renameSync(path.join(pack.projectDir, 'textures'), other);
  fs.symlinkSync(other, path.join(pack.projectDir, 'textures'));
  assert.throws(() => validateGodotPack(pack.projectDir), /unsafe directory/);
  assert.throws(() => rollbackGodotMaterialFamily(root, pack.version), /unsafe directory/);
});
