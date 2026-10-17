#!/usr/bin/env node
// Privacy gate: secret scanning with gitleaks (config: .gitleaks.toml at the repo root).
//   default (local)   scans the working tree (`gitleaks dir`), no git commands needed
//   --history / CI    scans full git history (`gitleaks git`); the workflow checks out with fetch-depth: 0
// Locally, a missing gitleaks is a SKIP with instructions; in CI (CI=true) it is a failure.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = resolve(here, '../..');
const inCI = process.env.CI === 'true' || process.env.CI === '1';
const history = process.argv.includes('--history') || inCI;

function which(cmd, args = ['--version']) { const r = spawnSync(cmd, args, { encoding: 'utf8' }); return r.status === 0; }
let bin = null;
if (existsSync(join(here, '../.bin/gitleaks'))) bin = join(here, '../.bin/gitleaks');
else if (which('gitleaks', ['version'])) bin = 'gitleaks';

const args = [history ? 'git' : 'dir', '--config', join(repo, '.gitleaks.toml'), '--redact', '--no-banner', '--exit-code', '1', repo];
let r;
if (bin) r = spawnSync(bin, args, { stdio: 'inherit', cwd: repo });
else if (which('docker', ['info'])) {
  r = spawnSync('docker', ['run', '--rm', '-v', `${repo}:/repo`, 'zricethezav/gitleaks:v8.28.0', ...args.slice(0, -1).map(a => a === join(repo, '.gitleaks.toml') ? '/repo/.gitleaks.toml' : a), '/repo'], { stdio: 'inherit' });
} else {
  const msg = 'gitleaks not found (no binary on PATH or tooling/.bin, no working docker). Install it with: node scripts/install-gitleaks.mjs';
  if (inCI) { console.error('SECRETS SCAN FAILED: ' + msg); process.exit(1); }
  console.log('SKIPPED secrets scan locally: ' + msg + '\n(CI always runs it over full history.)');
  process.exit(0);
}
if (r.status !== 0) { console.error('\nSECRETS SCAN FAILED'); process.exit(1); }
console.log(`secrets scan OK (${history ? 'full git history' : 'working tree'})`);
