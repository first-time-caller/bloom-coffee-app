#!/usr/bin/env node
/**
 * Writes the Content-Security-Policy <meta> in web/index.html so it always matches the page:
 *  - every inline <script> and <style> is allowed by SHA-256 hash (no 'unsafe-inline', no 'unsafe-eval');
 *  - connect-src is 'self' plus the origin in `const SYNC_BASE_URL = '...'` (or --origin, for local test builds).
 * Usage: node scripts/seal-web.ts [--check] [--origin https://sync.example.com] [--src ../../web/index.html] [--out file]
 * Run it after editing any inline script/style or SYNC_BASE_URL. `--check` exits 1 if the file is stale (also run as a unit test).
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sha = (s: string) => "'sha256-" + createHash('sha256').update(s, 'utf8').digest('base64') + "'";
const CONST = /const SYNC_BASE_URL = '([^']*)';/;

export function inlineHashes(html: string) {
  const grab = (re: RegExp) => [...html.matchAll(re)].map(m => m[1]).filter(t => t.trim()).map(sha);
  return { script: grab(/<script>([\s\S]*?)<\/script>/g), style: grab(/<style>([\s\S]*?)<\/style>/g) };
}

export function policy(html: string, origin: string) {
  const h = inlineHashes(html);
  const o = origin ? new URL(origin).origin : '';
  return [
    "default-src 'self'",
    `script-src 'self' ${h.script.join(' ')}`.trim(),
    `style-src 'self' ${h.style.join(' ')}`.trim(),
    "img-src 'self' data: blob:",
    `connect-src 'self'${o ? ' ' + o : ''}`,
    "font-src 'self'",
    "manifest-src 'self' blob: data:",
    "worker-src 'self'",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'"
  ].join('; ');
}

/** Returns the html with the origin constant and CSP meta set. */
export function seal(html: string, origin?: string): string {
  const withOrigin = origin === undefined ? html : html.replace(CONST, `const SYNC_BASE_URL = '${origin}';`);
  const current = CONST.exec(withOrigin)?.[1] ?? '';
  // the CSP meta has no inline content, so hashing is stable regardless of its own value
  return withOrigin.replace(/(<meta http-equiv="Content-Security-Policy" content=")[^"]*(">)/, (_m, a, b) => a + policy(withOrigin, current) + b);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
  const src = arg('--src') ?? fileURLToPath(new URL('../../../web/index.html', import.meta.url));
  const html = readFileSync(src, 'utf8');
  const out = seal(html, arg('--origin'));
  if (process.argv.includes('--check')) {
    if (out !== html) { console.error('web/index.html: Content-Security-Policy is stale. Run: npm run seal (in packages/sync)'); process.exit(1); }
    console.log('CSP is current');
  } else { writeFileSync(arg('--out') ?? src, out); console.log('sealed', arg('--out') ?? src); }
}
