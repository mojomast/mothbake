// Usage: node examples/workbench/prepare.mjs /path/to/empty-workspace
// Creates one tiny, entirely local image candidate; no remote calls or credentials.
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

const root = resolve(process.argv[2] || 'workbench-demo');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
await mkdir(join(root, 'candidates'), { recursive: true });
await writeFile(join(root, 'original.png'), png);
await writeFile(join(root, 'result.png'), png);
const sha256 = createHash('sha256').update(png).digest('hex');
await writeFile(join(root, 'candidates', 'local-demo.json'), JSON.stringify({
  version: 1, id: 'local-demo', kind: 'image',
  source: { path: 'original.png', sha256 }, result: { path: 'result.png', sha256 },
  params: { example: true }, parameterDelta: {}, backend: 'local-example',
  provenance: { note: 'Generated locally from an embedded 1×1 PNG' },
  qualityReport: { warnings: [] }, favorite: false, rejected: false, notes: '',
}, null, 2) + '\n');
console.log(`Prepared local candidate in ${root}`);
