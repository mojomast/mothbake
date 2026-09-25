import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createCandidateStore } from './candidates.mjs';
import { createApprovalStore } from './approvals.mjs';

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const uiRoot = new URL('./workbench-ui/', import.meta.url);
const loopback = new Set(['127.0.0.1', 'localhost', '::1']);
const errorText = (error) => error instanceof Error ? error.message : String(error);

/** Starts a read-only-by-default, loopback-only workbench. Call close() when finished. */
export async function startWorkbenchServer({ workspaceRoot, host = '127.0.0.1', port = 0, unsafeBind = false } = {}) {
  if (!workspaceRoot) throw new Error('workspaceRoot is required');
  if (!unsafeBind && !loopback.has(host)) throw new Error('Non-loopback bind requires unsafeBind: true');
  const candidates = createCandidateStore({ workspaceRoot });
  const approvals = createApprovalStore({ workspaceRoot });
  const token = randomBytes(32).toString('hex');
  let actualPort;
  const server = http.createServer(async (req, res) => {
    const json = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };
    try {
      const hostHeader = req.headers.host;
      const allowed = new Set([`localhost:${actualPort}`, `127.0.0.1:${actualPort}`, `[::1]:${actualPort}`]);
      if (typeof hostHeader !== 'string' || !allowed.has(hostHeader.toLowerCase())) return json(403, { error: 'Invalid Host' });
      const url = new URL(req.url, `http://${hostHeader}`);
      const pathname = url.pathname;
      const origin = `http://${hostHeader.toLowerCase()}`;
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; media-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      if (req.method === 'GET' && staticFiles.has(pathname)) {
        const [name, type] = staticFiles.get(pathname);
        let content = await readFile(fileURLToPath(new URL(name, uiRoot)));
        if (name === 'index.html') content = Buffer.from(content.toString().replace('__WORKBENCH_TOKEN__', token));
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(content);
      }
      if (req.method === 'GET' && pathname === '/api/candidates') {
        const valid = [];
        for (const candidate of await candidates.list()) {
          try {
            await candidates.readAsset(candidate.id, 'source');
            await candidates.readAsset(candidate.id, 'result');
            valid.push(candidate);
          } catch { /* Do not show an unverified candidate. */ }
        }
        return json(200, { candidates: valid });
      }
      if (req.method === 'GET' && pathname === '/api/approval') return json(200, { approval: await approvals.get() });
      const match = /^\/api\/candidates\/([^/]+)(?:\/(source|result))?$/.exec(pathname);
      if (req.method === 'GET' && match) {
        const id = decodeURIComponent(match[1]);
        if (!match[2]) {
          const candidate = await candidates.get(id);
          if (!candidate) return json(404, { error: 'Not found' });
          await candidates.readAsset(id, 'source');
          await candidates.readAsset(id, 'result');
          return json(200, { candidate });
        }
        const asset = await candidates.readAsset(id, match[2]);
        if (!asset) return json(404, { error: 'Not found' });
        // The candidate store must verify hashes again immediately before reading media.
        const candidate = await candidates.get(id);
        const ext = candidate[match[2]].path.split('.').at(-1).toLowerCase();
        const contentTypes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', json: 'application/json' };
        res.writeHead(200, { 'Content-Type': contentTypes[ext], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(asset);
      }
      if (req.method === 'POST' && /^\/api\/candidates\/[^/]+\/(favorite|reject|note|approve|supersede)$/.test(pathname)) {
        if (req.headers.origin !== origin) return json(403, { error: 'Invalid Origin' });
        if (req.headers['x-workbench-token'] !== token) return json(403, { error: 'Invalid session token' });
        if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') return json(415, { error: 'JSON required' });
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 16_384) return json(413, { error: 'Body too large' });
          chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { return json(400, { error: 'Invalid JSON' }); }
        if (!body || Array.isArray(body) || typeof body !== 'object') return json(400, { error: 'Invalid body' });
        const [, , , encodedId, action] = pathname.split('/');
        const id = decodeURIComponent(encodedId);
        const candidate = await candidates.get(id);
        if (!candidate) return json(404, { error: 'Not found' });
        if (action === 'favorite' || action === 'reject' || action === 'note') {
          const update = action === 'note' ? { notes: body.notes } : { [action === 'reject' ? 'rejected' : 'favorite']: body.value };
          return json(200, { candidate: await candidates.mutateMetadata(id, update) });
        }
        // Re-verify both assets before pinning an approval, not merely the JSON record.
        if (candidate.rejected) return json(400, { error: 'Rejected candidate cannot be approved' });
        if (body.planFingerprint !== candidate.provenance.planFingerprint) {
          return json(400, { error: 'Plan fingerprint does not match candidate' });
        }
        await candidates.readAsset(id, 'source');
        await candidates.readAsset(id, 'result');
        const approval = action === 'approve' ? await approvals.approve(candidate, body.planFingerprint) : await approvals.supersede(candidate, body.planFingerprint);
        return json(200, { approval });
      }
      return json(404, { error: 'Not found' });
    } catch (error) {
      const message = errorText(error);
      // Do not echo filesystem paths, JSON content, or secrets to callers.
      const status = /not found|ENOENT/i.test(message) ? 404 : /exists|already approved|approval required/i.test(message) ? 409 : 400;
      return json(status, { error: status === 404 ? 'Not found' : status === 409 ? 'Approval conflict' : 'Invalid candidate or request' });
    }
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
    actualPort = server.address().port;
  } catch (error) { server.close(); throw error; }
  return { server, url: `http://${host.includes(':') ? `[${host}]` : host}:${actualPort}`, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
