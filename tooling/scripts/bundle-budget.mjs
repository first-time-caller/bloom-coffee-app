#!/usr/bin/env node
// Speed gate: gzip budgets for the shipped bundles. Budgets live in tooling/budgets.json.
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, '../..');
const budgets = JSON.parse(readFileSync(join(here, '../budgets.json'), 'utf8')).bundles;
const skipBackend = process.argv.includes('--no-backend');
const gz = buf => gzipSync(buf, { level: 9 }).length;
const kb = n => (n / 1024).toFixed(2) + ' KB';

const rows = [];
for (const [name, b] of Object.entries(budgets)) {
  let buf;
  if (name.startsWith('backend worker')) {
    if (skipBackend) continue;
    const out = mkdtempSync(join(tmpdir(), 'bloom-worker-'));
    try {
      execFileSync('npx', ['wrangler', 'deploy', '--dry-run', '--outdir', out], { cwd: join(root, 'backend'), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } });
      buf = readFileSync(join(out, 'index.js'));
    } finally { rmSync(out, { recursive: true, force: true }); }
  } else {
    const p = join(root, name);
    if (!existsSync(p)) { rows.push({ name, size: NaN, budget: b.gzipBytes, ok: false }); continue; }
    buf = readFileSync(p);
  }
  const size = gz(buf);
  rows.push({ name, size, raw: buf.length, budget: b.gzipBytes, ok: size <= b.gzipBytes });
}
console.log('bundle'.padEnd(46), 'gzip'.padStart(11), 'budget'.padStart(11), 'used'.padStart(6));
for (const r of rows) console.log(r.name.padEnd(46), kb(r.size).padStart(11), kb(r.budget).padStart(11), (Math.round((r.size / r.budget) * 100) + '%').padStart(6), r.ok ? '' : ' OVER BUDGET');
const bad = rows.filter(r => !r.ok);
if (bad.length) { console.error(`\nBUNDLE BUDGET FAILED: ${bad.map(r => r.name).join(', ')}\nSee docs/QUALITY-GATES.md for how to change a budget deliberately.`); process.exit(1); }
console.log('\nbundle budgets OK');
