#!/usr/bin/env node
// Builds a single self-contained HTML file in "viewer mode" for hosts that
// wrap the page themselves and block downloads (e.g. a Claude artifact).
// Usage: node scripts/build-viewer.mjs [out=dist/atlas-ghost-viewer.html]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
const site = path.resolve('site');
const out = path.resolve(process.argv[2] || 'dist/atlas-ghost-viewer.html');
const read = f => readFile(path.join(site, f), 'utf8');
const html = await read('index.html');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'))
  .replace(/<script src="[^"]+"><\/script>\s*/g, '');
const config = `window.ATLAS_CONFIG = { apiBase: '', turnstileSiteKey: '', viewerMode: true };`;
const page = `<title>ATLAS GHOST Roast</title>
<style>${await read('styles.css')}</style>
${body.trim()}
<script>${config}</script>
<script>${await read('core.js')}</script>
<script>${await read('app.js')}</script>
`;
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, page);
console.log(`Wrote ${path.relative(process.cwd(), out)} (${(page.length / 1024).toFixed(1)} KB)`);
