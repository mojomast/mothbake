import { createMaterialFamily } from '../../src/material-family.mjs';

// Standalone, offline example; arrays can be fed directly to an RGBA8 image writer.
const { candidate, baseline, metadata } = createMaterialFamily({
  width: 128,
  height: 128,
  seed: 42,
  panelDensity: 6,
  grainDirection: 'horizontal',
  reliefStrength: 2.4,
  wearCoverage: 0.45,
  variationAmount: 0.65,
});

console.log(JSON.stringify({
  metadata,
  candidateSeams: candidate.quality,
  baselineSeams: baseline.quality,
  mapBytes: Object.fromEntries(Object.entries(candidate.maps).map(([name, map]) => [name, map.data.length])),
}, null, 2));
