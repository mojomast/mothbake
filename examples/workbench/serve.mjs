// Usage: node examples/workbench/serve.mjs /path/to/workspace
// Listens on loopback only. Press Ctrl+C to stop.
import { resolve } from 'node:path';
import { startWorkbenchServer } from '../../src/workbench-server.mjs';

const workspaceRoot = resolve(process.argv[2] || 'workbench-demo');
const app = await startWorkbenchServer({ workspaceRoot });
console.log(`Local workbench: ${app.url}`);
