// Rebuild the approved material locally and export a Godot project.
// Usage: node examples/local-first/finalize.mjs [workspace]

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createApprovalStore } from '../../src/approvals.mjs';
import { createCandidateStore } from '../../src/candidates.mjs';
import { encodePng } from '../../src/decoders/png.mjs';
import { exportGodotMaterialFamily, probeGodotPack, validateGodotPack } from '../../src/emitters/godot.mjs';
import { createMaterialFamily } from '../../src/material-family.mjs';

const workspace = path.resolve(process.argv[2] ?? 'local-first-workspace');
const approval = await createApprovalStore({ workspaceRoot: workspace }).get();
if (!approval) throw new Error('no approval; review and approve a candidate first');
const candidate = await createCandidateStore({ workspaceRoot: workspace }).get(approval.candidateId);
if (!candidate) throw new Error(`approved candidate missing: ${approval.candidateId}`);
const family = createMaterialFamily(candidate.params);
const preview = encodePng(family.candidate.width, family.candidate.height, family.candidate.maps.color.data, { alpha: true });
const digest = createHash('sha256').update(preview).digest('hex');
if (digest !== approval.result.sha256) throw new Error('offline rebuild does not match approved preview hash');
const output = path.join(workspace, 'delivery', 'godot');
const pack = exportGodotMaterialFamily(family.candidate, output);
validateGodotPack(pack.projectDir);
fs.writeFileSync(path.join(workspace, 'delivery', 'APPROVAL.json'), `${JSON.stringify(approval, null, 2)}\n`);
console.log(`Rebuilt approved ${approval.candidateId} with no credentials or network.`);
console.log(`Godot project: ${pack.projectDir}`);
console.log(`Godot runtime probe: ${probeGodotPack(pack.projectDir).status}`);
