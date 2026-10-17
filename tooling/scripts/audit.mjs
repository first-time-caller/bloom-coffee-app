#!/usr/bin/env node
// Privacy/supply-chain gate: dependency audit per package.
//   blocking:     npm audit --audit-level=high --omit=dev    (what ships)
//   non-blocking: npm audit (all deps)                       (report only, written to tooling/audit-reports/)
// Packages without a lockfile have nothing to audit and are skipped with a note.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, '../..');
const pkgs = ['packages/slog', 'backend', 'tooling'];
const reports = join(here, '../audit-reports');
mkdirSync(reports, { recursive: true });
let failed = false;

for (const p of pkgs) {
  const cwd = join(root, p);
  if (!existsSync(join(cwd, 'package-lock.json'))) { console.log(`${p}: no package-lock.json, skipped`); continue; }
  const prod = spawnSync('npm', ['audit', '--audit-level=high', '--omit=dev'], { cwd, encoding: 'utf8' });
  const full = spawnSync('npm', ['audit', '--json'], { cwd, encoding: 'utf8' });
  let counts = {};
  try { counts = JSON.parse(full.stdout).metadata?.vulnerabilities ?? {}; writeFileSync(join(reports, p.replace('/', '_') + '.json'), full.stdout); } catch { counts = { error: 'audit unavailable' }; }
  const out = (prod.stdout + prod.stderr).trim();
  if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|audit endpoint returned an error/i.test(out) && prod.status !== 0 && !/vulnerabilit/.test(out.replace(/audit endpoint/, ''))) {
    console.error(`${p}: audit could not reach the registry:\n${out}`); failed = true; continue;
  }
  const ok = prod.status === 0;
  console.log(`${p.padEnd(16)} prod deps (>=high): ${ok ? 'OK' : 'VULNERABLE'}   all deps (informational): ${JSON.stringify(counts)}`);
  if (!ok) { console.error(out); failed = true; }
}
if (failed) { console.error('\nDEPENDENCY AUDIT FAILED (high/critical in production dependencies)'); process.exit(1); }
console.log('\ndependency audit OK');
