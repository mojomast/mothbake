# Godot material export contract

Checked: 2026-09-25

The first native target is Godot 4. The current official stable documentation
served during this upgrade identifies Godot **4.7**. The exporter uses only
Godot 4 text resource/project syntax and `StandardMaterial3D`.

Primary sources:

- <https://docs.godotengine.org/en/stable/classes/class_standardmaterial3d.html>
- <https://docs.godotengine.org/en/stable/classes/class_basematerial3d.html>
- <https://docs.godotengine.org/en/stable/tutorials/assets_pipeline/importing_images.html>

Contract decisions:

- Albedo is an sRGB PNG. Height, normal, roughness and wear are linear data
  textures in the pack manifest.
- Godot expects X+, Y+, Z+ (OpenGL-style) tangent normals. The generated map is
  labelled `OpenGL +Y`; users must not enable the DirectX “invert Y” import
  option for it.
- `StandardMaterial3D` uses separate roughness and normal textures. Roughness is
  read from channel 0 (red).
- Height mapping uses the documented `heightmap_enabled`, `heightmap_scale` and
  `heightmap_texture` properties. Height and roughness/wear remain labelled
  synthesis heuristics, not recovered physical properties.
- Wear is delivered but not silently wired to an unrelated StandardMaterial3D
  property. A future custom shader/adapter can consume it explicitly.
- PNGs are self-contained source assets. Godot creates its own `.import` cache
  in a consumer project; Mothbake does not publish machine-specific import
  cache files.

`examples/local-first/finalize.mjs` publishes projects under
`delivery/godot/versions/<version>` and atomically updates
`delivery/godot/current.json`. This is distinct from the generic CLI approved
export, which uses `delivery/.versions/<version>` plus `delivery/current.json`.
Consumers resolve the relevant pointer; they do not select an arbitrary version
directory. Wear is present in the Godot pack manifest but deliberately not wired
to `StandardMaterial3D`.

`probeGodotPack()` invokes `godot --headless --path <pack> --editor --quit` when
available. Godot is not installed in the implementation environment, so runtime
resource import remains **unavailable**, not passed. `validateGodotPack()`
checks local hashes, PNG dimensions and resource references only; those checks
are not described as an engine import.
