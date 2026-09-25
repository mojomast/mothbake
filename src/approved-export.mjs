// Export exactly the currently approved candidate through a transactional pack.
// Candidate discovery/reruns never invoke this function and cannot replace the
// approved delivery implicitly.

import fs from 'node:fs';
import path from 'node:path';
import { createApprovalStore } from './approvals.mjs';
import { createCandidateStore } from './candidates.mjs';
import { canonicalJson, hashBytes, hashJson } from './identity.mjs';
import { publishPackVersion } from './transactional-pack.mjs';

export async function exportApprovedCandidate(options = {}) {
  const { workspaceRoot, exportRoot = path.join(workspaceRoot ?? '', 'delivery') } = options;
  if (typeof workspaceRoot !== 'string' || !workspaceRoot) throw new TypeError('workspaceRoot is required');
  const approvals = createApprovalStore({ workspaceRoot });
  const candidates = createCandidateStore({ workspaceRoot });
  const approval = await approvals.get();
  if (!approval) throw new Error('no approved candidate; approve one before export');
  const candidate = await candidates.get(approval.candidateId);
  if (!candidate) throw new Error(`approved candidate is missing: ${approval.candidateId}`);
  for (const role of ['source', 'result']) {
    if (candidate[role].path !== approval[role].path || candidate[role].sha256 !== approval[role].sha256) {
      throw new Error(`approved ${role} no longer matches the candidate record`);
    }
  }
  if (canonicalJson(candidate.provenance) !== canonicalJson(approval.provenance)) {
    throw new Error('approved provenance no longer matches the candidate record');
  }
  const source = await candidates.readAsset(candidate.id, 'source');
  const result = await candidates.readAsset(candidate.id, 'result');
  if (hashBytes(source) !== approval.source.sha256 || hashBytes(result) !== approval.result.sha256) {
    throw new Error('approved asset changed during export');
  }
  const sourceName = `source${path.posix.extname(candidate.source.path).toLowerCase()}`;
  const resultName = `result${path.posix.extname(candidate.result.path).toLowerCase()}`;
  const manifest = {
    version: 1,
    candidateId: candidate.id,
    kind: candidate.kind,
    planFingerprint: approval.planFingerprint,
    approvedAt: approval.approvedAt,
    source: { ...approval.source, file: `assets/${sourceName}` },
    result: { ...approval.result, file: `assets/${resultName}` },
    params: candidate.params,
    parameterDelta: candidate.parameterDelta,
    backend: candidate.backend,
    provenance: approval.provenance,
    qualityReport: candidate.qualityReport,
  };
  // Include the complete delivery contract, not just the result bytes. Two
  // approvals of identical output can still describe different exports.
  const versionId = `approved-${hashJson({ exporter: 'approved-export:v1', manifest })}`;
  return publishPackVersion({
    root: exportRoot,
    versionId,
    reuseExisting: true,
    build: async (staging) => {
      fs.mkdirSync(path.join(staging, 'assets'));
      fs.writeFileSync(path.join(staging, 'assets', sourceName), source);
      fs.writeFileSync(path.join(staging, 'assets', resultName), result);
      fs.writeFileSync(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    },
    validate: async (staging) => {
      const actual = JSON.parse(fs.readFileSync(path.join(staging, 'manifest.json'), 'utf8'));
      if (canonicalJson(actual) !== canonicalJson(manifest)) throw new Error('approved export manifest identity mismatch');
      const expectedFiles = new Set(['manifest.json', manifest.source.file, manifest.result.file]);
      const files = fs.readdirSync(path.join(staging, 'assets'));
      if (files.length !== expectedFiles.size - 1 || files.some((name) => !expectedFiles.has(`assets/${name}`))) {
        throw new Error('approved export contains unexpected assets');
      }
      for (const role of ['source', 'result']) {
        const bytes = fs.readFileSync(path.join(staging, manifest[role].file));
        if (hashBytes(bytes) !== manifest[role].sha256) throw new Error(`approved export ${role} SHA-256 mismatch`);
      }
    },
  });
}
