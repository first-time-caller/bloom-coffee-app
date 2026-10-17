#!/usr/bin/env node
// Reliability gate: migration lint. See docs/QUALITY-GATES.md.
//   node scripts/migration-lint.mjs               check
//   node scripts/migration-lint.mjs --update-lock add NEW migrations to migrations.lock.json (never rewrites an existing hash)
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintSql, checkNumbering } from './lib/migration-rules.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const dir = resolve(here, '../../backend/migrations');
const lockPath = resolve(here, '../migrations.lock.json');
const sha = buf => createHash('sha256').update(buf).digest('hex');

const names = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : { migrations: {} };
const problems = [];
const notes = [];

if (process.argv.includes('--update-lock')) {
  for (const n of names) {
    const h = sha(readFileSync(join(dir, n)));
    if (lock.migrations[n] && lock.migrations[n] !== h) problems.push(`${n} differs from its locked hash; locked migrations are immutable. Add a new migration instead.`);
    else lock.migrations[n] = h;
  }
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  console.log(`lock updated: ${Object.keys(lock.migrations).length} migrations`);
  process.exit(0);
}

problems.push(...checkNumbering(names));

for (const [n, h] of Object.entries(lock.migrations)) {
  if (!names.includes(n)) problems.push(`${n}: locked migration was deleted or renamed (migrations on main are immutable)`);
  else if (sha(readFileSync(join(dir, n))) !== h) problems.push(`${n}: contents changed since it was locked in migrations.lock.json (migrations on main are immutable; write a new migration)`);
}
for (const n of names) {
  if (!lock.migrations[n]) notes.push(`${n}: not yet locked (pending). After it merges to main run: npm run gate:migrations:lock`);
  for (const f of lintSql(readFileSync(join(dir, n), 'utf8'))) {
    if (f.allowed) notes.push(`${n}: ALLOWED ${f.rule} (reason: ${f.reason}) -> ${f.statement}`);
    else problems.push(`${n}: forbidden ${f.rule}: ${f.statement}\n      (if this is truly intended, add a preceding line: -- gate:allow-destructive <reason>)`);
  }
}

console.log(`checked ${names.length} migrations (${Object.keys(lock.migrations).length} locked)`);
for (const n of notes) console.log('  note: ' + n);
if (problems.length) { console.error('\nMIGRATION LINT FAILED'); for (const p of problems) console.error('  - ' + p); process.exit(1); }
console.log('migration lint OK');
