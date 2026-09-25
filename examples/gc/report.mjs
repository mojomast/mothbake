// Usage: node examples/gc/report.mjs [workspace-root]
// This emits diagnostics only; the GC report is never permission to delete.
import { buildGarbageReport } from '../../src/gc.mjs';

const workspaceRoot = process.argv[2] ?? process.cwd();
process.stdout.write(`${JSON.stringify(buildGarbageReport({ workspaceRoot }), null, 2)}\n`);
