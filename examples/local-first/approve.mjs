// Deliberate non-UI approval helper for automation/testing.
// Usage: node examples/local-first/approve.mjs <workspace> <candidate-id>

import fs from 'node:fs';
import path from 'node:path';
import { createApprovalStore } from '../../src/approvals.mjs';
import { createCandidateStore } from '../../src/candidates.mjs';

const workspace = path.resolve(process.argv[2] ?? 'local-first-workspace');
const id = process.argv[3];
if (!id) throw new Error('candidate id is required');
const plan = JSON.parse(fs.readFileSync(path.join(workspace, 'variation-plan.json'), 'utf8'));
const candidate = await createCandidateStore({ workspaceRoot: workspace }).get(id);
if (!candidate) throw new Error(`candidate not found: ${id}`);
await createApprovalStore({ workspaceRoot: workspace }).approve(candidate, plan.fingerprint);
console.log(`Approved ${id} at plan ${plan.fingerprint}`);
