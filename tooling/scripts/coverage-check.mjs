#!/usr/bin/env node
// Reliability gate, coverage half. Merges and enforces:
//   - packages/slog      (vitest v8)        >= 85% lines/branches/functions/statements   (also enforced by vitest itself)
//   - backend/src        (vitest istanbul)  >= 85% on the same four metrics
//   - packages/sync      (vitest v8)        >= 85% on the same four metrics. This is the source of web/bloom-sync.js (a minified
//                                           build output), so it is how bloom-sync.js is covered.
//   - web inline app script (Playwright V8 coverage across all e2e specs): reported, ratcheted against the same baseline file
// Usage: node scripts/coverage-check.mjs [--update-baseline]
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, '../..');
const baselinePath = join(here, '../coverage-baseline.json');
const update = process.argv.includes('--update-baseline');
const FLOOR = 85;
const TOLERANCE = 1.5; // percentage points of slack for the ratchet (timing-dependent branches, order of tests)
const failures = [];
const report = [];
const pct = (c, t) => (t === 0 ? 100 : Math.round((c / t) * 10000) / 100);

function summary(path) {
  if (!existsSync(path)) { failures.push(`missing ${path}: run the unit suites with coverage first (npm run gate:reliability runs them)`); return null; }
  return JSON.parse(readFileSync(path, 'utf8'));
}
function metrics(s) { return { lines: s.lines.pct, branches: s.branches.pct, functions: s.functions.pct, statements: s.statements.pct }; }

const measured = {};

// ---- unit suites ----
const slog = summary(join(root, 'packages/slog/coverage/coverage-summary.json'));
if (slog) {
  const m = metrics(slog.total);
  report.push(['packages/slog', m]);
  for (const [k, v] of Object.entries(m)) if (v < FLOOR) failures.push(`packages/slog ${k} ${v}% < ${FLOOR}%`);
}
const sync = summary(join(root, 'packages/sync/coverage/coverage-summary.json'));
if (sync) {
  const m = metrics(sync.total);
  report.push(['packages/sync (source of web/bloom-sync.js)', m]);
  for (const [k, v] of Object.entries(m)) if (v < FLOOR) failures.push(`packages/sync ${k} ${v}% < ${FLOOR}%`);
}
const be = summary(join(root, 'backend/coverage/coverage-summary.json'));
if (be) {
  const files = Object.entries(be).filter(([k]) => k !== 'total');
  const sumOf = list => {
    const acc = { lines: [0, 0], branches: [0, 0], functions: [0, 0], statements: [0, 0] };
    for (const [, s] of list) for (const k of Object.keys(acc)) { acc[k][0] += s[k].covered; acc[k][1] += s[k].total; }
    return Object.fromEntries(Object.entries(acc).map(([k, [c, t]]) => [k, pct(c, t)]));
  };
  const src = sumOf(files.filter(([k]) => k.includes('/backend/src/')));
  report.push(['backend/src', src]);
  for (const [k, v] of Object.entries(src)) if (v < FLOOR) failures.push(`backend/src ${k} ${v}% < ${FLOOR}%`);
}

// ---- Playwright V8 coverage of the scripts the page runs (inline app script, bloom-sync.js) ----
const TARGETS = [
  { name: 'webApp', label: 'web inline app script (e2e, V8)', match: e => /\/index\.html(\?|$)/.test(e.url) && e.source && e.source.length > 100_000 },
  { name: 'webSync', label: 'web/bloom-sync.js (e2e, V8, minified build)', match: e => /\/bloom-sync\.js(\?|$)/.test(e.url) && e.source }
];
const rawDir = join(here, '../coverage/raw');
if (existsSync(rawDir)) {
  const acc = Object.fromEntries(TARGETS.map(t => [t.name, { fns: new Map(), covered: null, len: 0 }]));
  for (const f of readdirSync(rawDir).filter(f => f.endsWith('.json'))) {
    for (const e of JSON.parse(readFileSync(join(rawDir, f), 'utf8'))) {
      const t = TARGETS.find(t => t.match(e)); if (!t) continue;
      const a = acc[t.name];
      a.len = e.source.length;
      const bits = new Uint8Array(e.source.length);
      for (const fn of e.functions) {
        const first = fn.ranges[0];
        const key = `${first.startOffset}:${fn.functionName}`;
        a.fns.set(key, a.fns.get(key) || first.count > 0);
        // ranges are ordered outer-to-inner: later (nested) ranges override the enclosing block's count
        for (const r of fn.ranges) bits.fill(r.count > 0 ? 1 : 0, r.startOffset, r.endOffset);
      }
      if (!a.covered) a.covered = new Uint8Array(bits.length);
      for (let i = 0; i < bits.length; i++) a.covered[i] |= bits[i];
    }
  }
  for (const t of TARGETS) {
    const a = acc[t.name];
    if (!a.covered) { failures.push(`no V8 coverage collected for ${t.label} (run the e2e suite first: npm run test:e2e)`); continue; }
    let on = 0; for (const b of a.covered) on += b;
    measured[t.name] = { bytes: pct(on, a.len), functions: pct([...a.fns.values()].filter(Boolean).length, a.fns.size), functionCount: a.fns.size };
    report.push([t.label, measured[t.name]]);
  }
} else {
  failures.push('no Playwright coverage found: run the e2e suite first (npm run test:e2e), with E2E_COVERAGE unset');
}

// ---- ratchet ----
const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};
if (update) {
  const next = { _comment: 'Coverage ratchet. Values may only go up. Regenerate deliberately with: npm --prefix tooling run coverage:baseline (see docs/QUALITY-GATES.md).', ...baseline, ...measured };
  writeFileSync(baselinePath, JSON.stringify(next, null, 2) + '\n');
  console.log(`baseline written to ${baselinePath}`);
} else {
  for (const [name, now] of Object.entries(measured)) {
    const base = baseline[name];
    if (!base) { failures.push(`no baseline recorded for ${name}; run with --update-baseline and commit coverage-baseline.json`); continue; }
    for (const [k, v] of Object.entries(base)) {
      if (typeof v !== 'number' || k === 'functionCount') continue;
      if (now[k] + TOLERANCE < v) failures.push(`${name} ${k} ${now[k]}% fell below the ratchet baseline ${v}% (tolerance ${TOLERANCE}pt)`);
    }
  }
}

for (const [name, m] of report) console.log(name.padEnd(48), Object.entries(m).map(([k, v]) => `${k} ${v}${typeof v === 'number' && k !== 'functionCount' ? '%' : ''}`).join('  '));
if (failures.length) { console.error('\nCOVERAGE GATE FAILED\n - ' + failures.join('\n - ')); process.exit(1); }
console.log('\ncoverage gate OK');
