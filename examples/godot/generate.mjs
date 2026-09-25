// Run: node examples/godot/generate.mjs [output-directory]
// Open the printed project directory in Godot 4. No external assets or key needed.
import path from 'node:path';
import { createMaterialFamily } from '../../src/material-family.mjs';
import { exportGodotMaterialFamily, probeGodotPack } from '../../src/emitters/godot.mjs';

const family = createMaterialFamily({
  width: 128, height: 128, panelDensity: 5, grainDirection: 'horizontal',
  reliefStrength: 2.5, wearCoverage: 0.35, variationAmount: 0.6, seed: 42,
});
const output = path.resolve(process.argv[2] ?? 'godot-material-output');
const result = exportGodotMaterialFamily(family.candidate, output);
console.log(`Godot 4 project: ${result.projectDir}`);
console.log(`Candidate seam quality: ${JSON.stringify(family.candidate.quality)}`);
console.log(`Probe: ${probeGodotPack(result.projectDir).status}`);
