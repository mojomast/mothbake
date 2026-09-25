// Standalone Godot 4 material-family project. Open <outputDir>/versions/<current.version>
// as the Godot project; publishing only replaces the atomic current.json pointer.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { encodePng, decodePng } from '../decoders/png.mjs';

const NAMES = ['color', 'height', 'normal', 'roughness', 'wear'];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function directory(dir, create = false) {
  const absolute = path.resolve(dir);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (create && !fs.existsSync(cursor)) fs.mkdirSync(cursor);
    const stat = fs.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`godot: unsafe directory: ${cursor}`);
  }
  return absolute;
}

function child(root, name, create = false) {
  return directory(path.join(root, name), create);
}

function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`godot: unsafe file: ${file}`);
  return fs.readFileSync(file);
}

function exists(file) {
  try { fs.lstatSync(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function dimensions(width, height, label) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
      width > 16384 || height > 16384 || width * height > 64 * 1024 * 1024) {
    throw new Error(`godot: invalid ${label} dimensions`);
  }
}

function validateRecord(record) {
  if (!record || typeof record !== 'object') throw new Error('godot: record required');
  dimensions(record.width, record.height, 'record');
  if (!record.maps || typeof record.maps !== 'object') throw new Error('godot: maps required');
  for (const name of NAMES) {
    const map = record.maps[name];
    if (!map || typeof map !== 'object') throw new Error(`godot: missing ${name} map`);
    dimensions(map.width, map.height, name);
    if (map.width !== record.width || map.height !== record.height ||
        !(map.data instanceof Uint8Array) || map.data.length !== map.width * map.height * 4) {
      throw new Error(`godot: invalid ${name} RGBA map (expected ${record.width}x${record.height})`);
    }
  }
  if (record.metadata !== undefined) {
    try {
      const text = JSON.stringify(record.metadata);
      if (!text || text.length > 100000) throw new Error('invalid metadata');
    } catch { throw new Error('godot: metadata must be JSON serializable'); }
  }
}

function material() {
  const resources = ['color', 'normal', 'roughness', 'height'].map((name, i) =>
    `[ext_resource type="Texture2D" path="res://textures/${name}.png" id="${i + 1}_${name}"]`).join('\n');
  return `[gd_resource type="StandardMaterial3D" load_steps=5 format=3]\n\n${resources}\n\n` +
    `[resource]\nresource_name = "Material Family"\nalbedo_texture = ExtResource("1_color")\n` +
    `normal_enabled = true\nnormal_texture = ExtResource("2_normal")\n` +
    `roughness_texture = ExtResource("3_roughness")\nroughness_texture_channel = 0\n` +
    `heightmap_enabled = true\nheightmap_scale = 0.05\nheightmap_texture = ExtResource("4_height")\n`;
}

function scene() {
  return `[gd_scene load_steps=5 format=3]\n\n` +
    `[ext_resource type="Material" path="res://material.tres" id="1_mat"]\n\n` +
    `[sub_resource type="PlaneMesh" id="PlaneMesh_1"]\nsize = Vector2(2, 2)\n\n` +
    `[sub_resource type="SphereMesh" id="SphereMesh_1"]\n\n` +
    `[sub_resource type="BoxMesh" id="BoxMesh_1"]\n\n` +
    `[node name="MaterialFamilyDemo" type="Node3D"]\n\n` +
    `[node name="Plane" type="MeshInstance3D" parent="."]\ntransform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, -2, 0, 0)\nmesh = SubResource("PlaneMesh_1")\nsurface_material_override/0 = ExtResource("1_mat")\n\n` +
    `[node name="Sphere" type="MeshInstance3D" parent="."]\ntransform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0.7, 0)\nmesh = SubResource("SphereMesh_1")\nsurface_material_override/0 = ExtResource("1_mat")\n\n` +
    `[node name="Cube" type="MeshInstance3D" parent="."]\ntransform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 2, 0.5, 0)\nmesh = SubResource("BoxMesh_1")\nsurface_material_override/0 = ExtResource("1_mat")\n\n` +
    `[node name="Camera3D" type="Camera3D" parent="."]\ntransform = Transform3D(1, 0, 0, 0, 0.707107, -0.707107, 0, 0.707107, 0.707107, 0, 4, 8)\ncurrent = true\n\n` +
    `[node name="Sun" type="DirectionalLight3D" parent="."]\nrotation = Vector3(-0.8, -0.4, 0)\n`;
}

function filesFor(root) {
  child(root, 'textures');
  return ['project.godot', 'material.tres', 'demo.tscn', ...NAMES.map((n) => `textures/${n}.png`)]
    .map((file) => ({ file, bytes: regular(path.join(root, file)) }));
}

export function validateGodotPack(projectDir) {
  const root = directory(projectDir);
  const manifest = JSON.parse(regular(path.join(root, 'manifest.json')).toString('utf8'));
  if (manifest.schemaVersion !== 1 || !manifest.files || typeof manifest.files !== 'object') throw new Error('godot: invalid manifest');
  const files = filesFor(root);
  if (Object.keys(manifest.files).length !== files.length) throw new Error('godot: unexpected manifest files');
  for (const { file, bytes } of files) {
    if (manifest.files[file]?.sha256 !== sha256(bytes) || manifest.files[file]?.bytes !== bytes.length) {
      throw new Error(`godot: hash mismatch: ${file}`);
    }
  }
  const tres = regular(path.join(root, 'material.tres')).toString('utf8');
  const sceneText = regular(path.join(root, 'demo.tscn')).toString('utf8');
  if (!/run\/main_scene="res:\/\/demo.tscn"/.test(regular(path.join(root, 'project.godot')).toString('utf8'))) {
    throw new Error('godot: missing main scene reference');
  }
  for (const name of ['color', 'normal', 'roughness', 'height']) {
    if (!tres.includes(`path="res://textures/${name}.png"`)) throw new Error(`godot: missing ${name} reference`);
  }
  if (!/heightmap_enabled = true/.test(tres) || !/heightmap_texture = ExtResource\("4_height"\)/.test(tres)) throw new Error('godot: missing heightmap configuration');
  for (const name of NAMES) {
    if (manifest.maps?.[name]?.file !== `textures/${name}.png`) throw new Error(`godot: invalid ${name} manifest reference`);
    const image = decodePng(regular(path.join(root, 'textures', `${name}.png`)));
    if (image.width !== manifest.width || image.height !== manifest.height) throw new Error(`godot: ${name} dimensions mismatch`);
  }
  for (const text of [tres, sceneText]) {
    for (const [, ref] of text.matchAll(/path="(res:\/\/[^"\n]+)"/g)) {
      if (!/^[a-zA-Z0-9_./-]+$/.test(ref.slice(6)) || ref.includes('..') ||
          !files.some(({ file }) => file === ref.slice(6))) throw new Error(`godot: invalid resource reference: ${ref}`);
    }
  }
  if (!sceneText.includes('path="res://material.tres"') ||
      !['PlaneMesh', 'SphereMesh', 'BoxMesh'].every((type) => sceneText.includes(`type="${type}"`))) {
    throw new Error('godot: invalid scene references');
  }
  return manifest;
}

function pointer(root, version, manifestHash) {
  if (exists(path.join(root, 'current.json'))) regular(path.join(root, 'current.json'));
  const tmp = path.join(root, `.current-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, json({ schemaVersion: 1, version, manifestSha256: manifestHash }), { flag: 'wx' });
    fs.renameSync(tmp, path.join(root, 'current.json'));
  } finally { fs.rmSync(tmp, { force: true }); }
}

function versionDirectory(root, version) {
  if (typeof version !== 'string' || !/^v-[a-f0-9-]{36}$/.test(version)) throw new Error('godot: invalid version');
  return child(child(root, 'versions'), version);
}

export function readCurrentGodotPack(outputDir) {
  const root = directory(outputDir);
  const current = JSON.parse(regular(path.join(root, 'current.json')).toString('utf8'));
  if (current.schemaVersion !== 1) throw new Error('godot: invalid pointer');
  const projectDir = versionDirectory(root, current.version);
  if (sha256(regular(path.join(projectDir, 'manifest.json'))) !== current.manifestSha256) throw new Error('godot: pointer hash mismatch');
  return { ...current, projectDir, manifest: validateGodotPack(projectDir) };
}

export function rollbackGodotMaterialFamily(outputDir, version) {
  const root = directory(outputDir);
  const projectDir = versionDirectory(root, version);
  validateGodotPack(projectDir);
  pointer(root, version, sha256(regular(path.join(projectDir, 'manifest.json'))));
  return readCurrentGodotPack(root);
}

export function exportGodotMaterialFamily(record, outputDir, options = {}) {
  validateRecord(record);
  if (!options || typeof options !== 'object') throw new Error('godot: invalid options');
  const root = directory(outputDir, true);
  const versions = child(root, 'versions', true);
  // Never replace an existing pointer symlink, even though rename itself would not follow it.
  const currentPath = path.join(root, 'current.json');
  if (exists(currentPath)) regular(currentPath);
  const version = `v-${randomUUID()}`;
  const stage = path.join(root, `.stage-${randomUUID()}`);
  const destination = path.join(versions, version);
  fs.mkdirSync(stage);
  let promoted = false;
  try {
    fs.mkdirSync(path.join(stage, 'textures'));
    for (const name of NAMES) {
      const map = record.maps[name];
      fs.writeFileSync(path.join(stage, 'textures', `${name}.png`), encodePng(map.width, map.height, map.data, { alpha: true }));
    }
    fs.writeFileSync(path.join(stage, 'material.tres'), material());
    fs.writeFileSync(path.join(stage, 'demo.tscn'), scene());
    fs.writeFileSync(path.join(stage, 'project.godot'),
      `config_version=5\n\n[application]\nconfig/name="Material Family Demo"\nrun/main_scene="res://demo.tscn"\n\n[rendering]\nrenderer/rendering_method="gl_compatibility"\nrenderer/rendering_method.mobile="gl_compatibility"\n`);
    options.onStage?.('files', stage);
    const files = Object.fromEntries(filesFor(stage).map(({ file, bytes }) => [file, { bytes: bytes.length, sha256: sha256(bytes) }]));
    const manifest = {
      schemaVersion: 1, generator: 'mothbake-godot', width: record.width, height: record.height,
      maps: Object.fromEntries(NAMES.map((name) => [name, {
        file: `textures/${name}.png`, colorSpace: name === 'color' ? 'sRGB' : 'linear',
        interpretation: name === 'normal' ? 'tangent-space OpenGL (+Y)' : name === 'height' ? 'white=high; parallax scale 0.05 (heuristic)' :
          name === 'wear' ? 'wear mask (synthesis heuristic; not recovered physical truth; not connected to material)' : name === 'roughness' ? 'red channel; 0=smooth, 1=rough (synthesis heuristic; not recovered physical truth)' : 'albedo',
      }])), files,
    };
    if (record.metadata !== undefined) manifest.metadata = JSON.parse(JSON.stringify(record.metadata));
    fs.writeFileSync(path.join(stage, 'manifest.json'), json(manifest));
    options.onStage?.('manifest', stage);
    validateGodotPack(stage);
    fs.renameSync(stage, destination);
    promoted = true;
    options.onStage?.('promotion', destination);
    validateGodotPack(destination);
    pointer(root, version, sha256(regular(path.join(destination, 'manifest.json'))));
    return readCurrentGodotPack(root);
  } finally {
    if (!promoted) fs.rmSync(stage, { recursive: true, force: true });
    // A completed but unpublished version is retained for inspection and recovery.
  }
}

export function probeGodotPack(projectDir, { executable = 'godot', timeout = 30000 } = {}) {
  const root = directory(projectDir);
  validateGodotPack(root);
  const result = spawnSync(executable, ['--headless', '--path', root, '--editor', '--quit'], { encoding: 'utf8', timeout });
  if (['ENOENT', 'EACCES'].includes(result.error?.code)) return { status: 'unavailable' };
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return { status: result.status === 0 && !result.error && !/^\s*(ERROR:|SCRIPT ERROR:)/m.test(output) ? 'ok' : 'failed',
    exitCode: result.status, output, error: result.error?.message };
}
