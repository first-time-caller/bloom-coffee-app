#!/usr/bin/env node
// Downloads a pinned gitleaks release into tooling/.bin/ and verifies its SHA-256. Used by CI and optionally locally.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

export const GITLEAKS_VERSION = '8.28.0';
const SHA256 = { 'linux_x64': 'a65b5253807a68ac0cafa4414031fd740aeb55f54fb7e55f386acb52e6a840eb' }; // from gitleaks_8.28.0_checksums.txt
const here = fileURLToPath(new URL('.', import.meta.url));
const bin = resolve(here, '../.bin');
const target = join(bin, 'gitleaks');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (existsSync(target)) { console.log('gitleaks already installed at ' + target); process.exit(0); }
  const plat = `${process.platform === 'darwin' ? 'darwin' : 'linux'}_${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
  if (!SHA256[plat]) { console.error(`no pinned checksum for ${plat}; install gitleaks manually (https://github.com/gitleaks/gitleaks)`); process.exit(1); }
  const url = `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_${plat}.tar.gz`;
  const res = await fetch(url);
  if (!res.ok) { console.error(`download failed: ${res.status} ${url}`); process.exit(1); }
  const buf = Buffer.from(await res.arrayBuffer());
  const got = createHash('sha256').update(buf).digest('hex');
  if (got !== SHA256[plat]) { console.error(`checksum mismatch for ${url}\n expected ${SHA256[plat]}\n got      ${got}`); process.exit(1); }
  mkdirSync(bin, { recursive: true });
  const tgz = join(tmpdir(), `gitleaks-${process.pid}.tgz`);
  writeFileSync(tgz, buf);
  execFileSync('tar', ['-xzf', tgz, '-C', bin, 'gitleaks']);
  rmSync(tgz, { force: true });
  chmodSync(target, 0o755);
  console.log(`installed gitleaks ${GITLEAKS_VERSION} to ${target}`);
}
