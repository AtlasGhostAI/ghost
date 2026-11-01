#!/usr/bin/env node
// Zero-dependency static server for local testing. Applies site/_headers
// (the same CSP Cloudflare Pages will send) so CSP problems show up locally.
// Usage: node scripts/serve.mjs [dir=site] [port=8080]
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] || 'site');
const port = Number(process.argv[3] || process.env.PORT || 8080);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };

export async function loadHeaders(dir) {
  try {
    const out = {};
    const lines = (await readFile(path.join(dir, '_headers'), 'utf8')).split('\n');
    let active = false;
    for (const l of lines) {
      if (!l.trim() || l.trim().startsWith('#')) continue;
      if (!/^\s/.test(l)) { active = l.trim() === '/*'; continue; }
      const i = l.indexOf(':');
      if (active && i > 0) out[l.slice(0, i).trim()] = l.slice(i + 1).trim();
    }
    return out;
  } catch { return {}; }
}

export async function startServer(dir = root, p = port, extraHeaders = {}) {
  const headers = { ...(await loadHeaders(dir)), ...extraHeaders };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      let file = path.normalize(path.join(dir, decodeURIComponent(url.pathname)));
      if (!file.startsWith(dir)) { res.writeHead(403).end(); return; }
      if ((await stat(file).catch(() => null))?.isDirectory()) file = path.join(file, 'index.html');
      if (path.basename(file).startsWith('_')) { res.writeHead(404).end(); return; }
      const body = await readFile(file);
      res.writeHead(200, { ...headers, 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/html' }).end('<h1>404</h1>');
    }
  });
  await new Promise(r => server.listen(p, '127.0.0.1', r));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startServer();
  console.log(`Serving ${root} at http://localhost:${port}`);
}
