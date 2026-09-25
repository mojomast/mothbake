// Zero-credential candidate preparation.
// Usage: node examples/local-first/prepare.mjs [workspace]

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createCandidateStore } from '../../src/candidates.mjs';
import { encodePng } from '../../src/decoders/png.mjs';
import { createMaterialFamily } from '../../src/material-family.mjs';
import { resolveVariationPlan } from '../../src/variations.mjs';

const workspace = path.resolve(process.argv[2] ?? 'local-first-workspace');
fs.mkdirSync(path.join(workspace, 'assets'), { recursive: true });
const request = {
  version: 1,
  baselineId: 'metal-panel',
  baselineParams: { width: 96, height: 96, panelDensity: 5, grainDirection: 'horizontal', reliefStrength: 2.5, wearCoverage: 0.3, variationAmount: 0.5, seed: 42 },
  parameters: {
    panelDensity: { values: [4, 6] },
    wearCoverage: { values: [0.2, 0.5] },
    variationAmount: { values: [0.4, 0.7] },
  },
  count: 4,
  seed: 20260925,
};
const plan = resolveVariationPlan(request);
fs.writeFileSync(path.join(workspace, 'variation-plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
const store = createCandidateStore({ workspaceRoot: workspace });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

for (const entry of plan.candidates) {
  const family = createMaterialFamily(entry.params);
  const source = encodePng(family.baseline.width, family.baseline.height, family.baseline.maps.color.data, { alpha: true });
  const result = encodePng(family.candidate.width, family.candidate.height, family.candidate.maps.color.data, { alpha: true });
  const sourcePath = `assets/${entry.id}-baseline.png`;
  const resultPath = `assets/${entry.id}-candidate.png`;
  fs.writeFileSync(path.join(workspace, sourcePath), source);
  fs.writeFileSync(path.join(workspace, resultPath), result);
  await store.addCandidate({
    version: 1,
    id: entry.id,
    kind: 'material',
    source: { path: sourcePath, sha256: sha(source) },
    result: { path: resultPath, sha256: sha(result) },
    params: entry.params,
    parameterDelta: entry.parameterDelta,
    backend: 'local:material-family-v1',
    provenance: { planFingerprint: plan.fingerprint, source: 'procedural', remoteJobs: 0 },
    qualityReport: family.candidate.quality,
    favorite: false,
    rejected: false,
    notes: '',
  });
}

console.log(`Prepared ${plan.candidates.length} candidates in ${workspace}`);
console.log(`Plan fingerprint: ${plan.fingerprint}`);
console.log(`Review: node bin/mothbake.mjs workbench --out ${workspace}`);
