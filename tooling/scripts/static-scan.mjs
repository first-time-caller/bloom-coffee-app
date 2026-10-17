#!/usr/bin/env node
// Privacy gate, static half: scan web/ for third-party URLs, analytics SDKs and beacons, and lint for a CSP.
// Known defects are listed in tooling/known-bugs.json: they are reported (not failed) while listed, and the gate
// fails if a listed defect disappears (stale entry) or a NEW one appears.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const web = resolve(here, '../../web');
const allowed = new Set(JSON.parse(readFileSync(join(here, '../allowed-hosts.json'), 'utf8')).hosts);
const known = JSON.parse(readFileSync(join(here, '../known-bugs.json'), 'utf8'));

// XML namespace identifiers are not network requests.
const NAMESPACES = new Set(['www.w3.org']);
const ANALYTICS = /\b(gtag\s*\(|google-analytics|googletagmanager|analytics\.js|ga\s*\(\s*['"]create|cdn\.segment|segment\.(?:com|io)|analytics\.(?:identify|track|page)\s*\(|mixpanel|amplitude|sentry|posthog|hotjar|fullstory|logrocket|bugsnag|rollbar|newrelic|nr-data|datadoghq|clarity\.ms|plausible\.io|matomo|_paq\.push|fbq\s*\(|connect\.facebook|twq\s*\(|heap\.load|intercom|crisp\.chat|hs-scripts)/i;
const BEACON = /navigator\s*\.\s*sendBeacon|\bsendBeacon\s*\(/;
const URL_RE = /\bhttps?:\/\/([a-z0-9.-]+\.[a-z]{2,}|localhost|127\.0\.0\.1)(?::\d+)?[^\s"'`)<>]*/gi;

function* walk(dir) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) { if (n !== 'node_modules') yield* walk(p); } else if (['.html', '.js', '.css', '.json', '.svg', '.webmanifest', '.txt'].includes(extname(p)) || n === '_headers') yield p;
  }
}

const hostsSeen = new Map(); // host -> [file:line]
const violations = [];
for (const file of walk(web)) {
  const rel = relative(resolve(here, '../..'), file);
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (line.length > 20000) return; // minified vendor blobs: matched by regex below on a per-match basis only
    for (const m of line.matchAll(URL_RE)) {
      const host = m[1].toLowerCase();
      if (NAMESPACES.has(host)) continue;
      (hostsSeen.get(host) ?? hostsSeen.set(host, []).get(host)).push(`${rel}:${i + 1}`);
    }
    const a = line.match(ANALYTICS); if (a) violations.push(`${rel}:${i + 1}: analytics SDK reference "${a[0]}"`);
    if (BEACON.test(line)) violations.push(`${rel}:${i + 1}: navigator.sendBeacon`);
  });
  // minified single-line vendor files: scan the whole text
  const text = readFileSync(file, 'utf8');
  if (text.split('\n').some(l => l.length > 20000)) {
    for (const m of text.matchAll(URL_RE)) if (!NAMESPACES.has(m[1].toLowerCase())) (hostsSeen.get(m[1].toLowerCase()) ?? hostsSeen.set(m[1].toLowerCase(), []).get(m[1].toLowerCase())).push(`${rel}:(minified)`);
    const a = text.match(ANALYTICS); if (a) violations.push(`${rel}: analytics SDK reference "${a[0]}"`);
    if (BEACON.test(text)) violations.push(`${rel}: navigator.sendBeacon`);
  }
}

const knownHosts = known.thirdPartyHosts || {};
const reported = [];
for (const [host, where] of hostsSeen) {
  if (allowed.has(host)) continue;
  if (knownHosts[host]) { reported.push(`${host} (${[...new Set(where)].slice(0, 3).join(', ')})\n      ${knownHosts[host]}`); continue; }
  violations.push(`third-party URL host "${host}" at ${[...new Set(where)].slice(0, 3).join(', ')} (not in tooling/allowed-hosts.json)`);
}
for (const host of Object.keys(knownHosts)) if (!hostsSeen.has(host)) violations.push(`stale known-bug: "${host}" no longer appears in web/. Remove it from tooling/known-bugs.json.`);

// ---- CSP lint ----
let csp = null;
const html = readFileSync(join(web, 'index.html'), 'utf8');
const meta = html.match(/<meta[^>]+http-equiv\s*=\s*["']?Content-Security-Policy["']?[^>]*>/i);
if (meta) { const c = meta[0].match(/content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i); csp = c ? (c[1] ?? c[2]) : ''; }
try {
  const headers = readFileSync(join(web, '_headers'), 'utf8');
  const h = headers.match(/^\s*Content-Security-Policy\s*:\s*(.+)$/im); if (h) csp = csp ? csp + '; ' + h[1] : h[1];
} catch { /* no _headers */ }
if (csp === null) {
  if (known.csp) reported.push(`Content-Security-Policy missing\n      ${known.csp}`);
  else violations.push('no Content-Security-Policy (meta tag in web/index.html or web/_headers)');
} else {
  if (known.csp) violations.push('stale known-bug: a CSP now exists. Remove "csp" from tooling/known-bugs.json.');
  if (!/default-src|script-src/.test(csp)) violations.push('CSP defines neither default-src nor script-src');
  if (/unsafe-eval/.test(csp)) violations.push("CSP allows 'unsafe-eval'");
  if (/script-src[^;]*'unsafe-inline'/.test(csp)) violations.push("CSP script-src allows 'unsafe-inline' (use a hash or nonce for the inline app script)");
  if (/(default|script|connect|img|font|style)-src[^;]*\s\*(\s|;|$)/.test(csp)) violations.push('CSP uses a wildcard source');
}

console.log(`scanned web/: ${hostsSeen.size} distinct external host(s) referenced: ${[...hostsSeen.keys()].join(', ') || 'none'}`);
for (const r of reported) console.log('  KNOWN-BUG ' + r);
if (violations.length) { console.error('\nSTATIC PRIVACY SCAN FAILED'); for (const v of violations) console.error('  - ' + v); process.exit(1); }
console.log(`static privacy scan OK (${reported.length} known bug(s) reported)`);
