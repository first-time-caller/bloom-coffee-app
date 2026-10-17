#!/usr/bin/env node
// Minimal static server for web/ (no dependencies). Used by Playwright and Lighthouse CI.
// Mirrors a plain static host: gzip is applied so Lighthouse sees realistic transfer sizes.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createGzip } from 'node:zlib';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const root = resolve(fileURLToPath(new URL('../../web', import.meta.url)));
const port = Number(process.env.PORT || process.argv[2] || 4173);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' };
// Optional extra headers from web/_headers (Cloudflare Pages / Netlify format), so a CSP defined there is really served.
async function extraHeaders(pathname) {
  try {
    const lines = (await readFile(join(root, '_headers'), 'utf8')).split(/\r?\n/);
    const out = {}; let active = false;
    for (const l of lines) {
      if (!l.trim() || l.trim().startsWith('#')) continue;
      if (!/^\s/.test(l)) { const pat = l.trim(); active = pat === '/*' || pat === pathname || (pat.endsWith('*') && pathname.startsWith(pat.slice(0, -1))); continue; }
      if (active) { const i = l.indexOf(':'); if (i > 0) out[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
    }
    return out;
  } catch { return {}; }
}

createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(root, p));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    const st = await stat(file).catch(() => null);
    if (!st || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
    const body = await readFile(file);
    const headers = { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', ...(await extraHeaders(p)) };
    const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && /^(text|application\/(json|javascript))|svg/.test(headers['content-type']);
    if (gz) { headers['content-encoding'] = 'gzip'; headers.vary = 'Accept-Encoding'; res.writeHead(200, headers); Readable.from(body).pipe(createGzip()).pipe(res); }
    else { headers['content-length'] = body.length; res.writeHead(200, headers).end(body); }
  } catch (e) { res.writeHead(500).end(String(e)); }
}).listen(port, '127.0.0.1', () => console.log(`serving ${root} on http://127.0.0.1:${port}`));
