#!/usr/bin/env node
// Speed gate: parser benchmark regression check.
//   node scripts/bench-check.mjs                 run vitest bench, compare to bench/baseline.json
//   node scripts/bench-check.mjs --update        rewrite the baseline (deliberate; see docs/QUALITY-GATES.md)
// Each benchmark's ops/sec is divided by the calibration loop's ops/sec measured in the same process, so the comparison is
// machine-independent. Fails if a benchmark is more than 25% slower (relative) than baseline. Best of 2 attempts to absorb noise.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const tooling = resolve(here, '..');
const baselinePath = join(tooling, 'bench/baseline.json');
const out = join(tooling, 'bench/.results.json');
const MAX_SLOWDOWN = 0.25;

function run() {
  mkdirSync(join(tooling, 'bench'), { recursive: true });
  const r = spawnSync('npx', ['vitest', 'bench', '--run', '--outputJson', out], { cwd: tooling, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stdout, r.stderr); throw new Error('vitest bench failed'); }
  const j = JSON.parse(readFileSync(out, 'utf8'));
  const hz = {};
  for (const f of j.files) for (const g of f.groups) for (const b of g.benchmarks) hz[b.name] = b.hz;
  const cal = hz.calibration;
  if (!cal) throw new Error('calibration benchmark missing');
  return { hz, rel: Object.fromEntries(Object.entries(hz).filter(([k]) => k !== 'calibration').map(([k, v]) => [k, v / cal])) };
}

const attempts = [run()];
if (process.argv.includes('--update')) {
  const second = run();
  const rel = Object.fromEntries(Object.keys(attempts[0].rel).map(k => [k, Math.min(attempts[0].rel[k], second.rel[k])]));
  writeFileSync(baselinePath, JSON.stringify({ _comment: 'ops/sec relative to the calibration loop (min of 2 runs). Regenerate with: npm run gate:bench -- --update', maxSlowdown: MAX_SLOWDOWN, rel }, null, 2) + '\n');
  console.log('baseline written:', rel); process.exit(0);
}
if (!existsSync(baselinePath)) { console.error('no bench/baseline.json; run with --update'); process.exit(1); }
const base = JSON.parse(readFileSync(baselinePath, 'utf8'));
const check = res => Object.entries(base.rel).map(([k, b]) => ({ k, base: b, now: res.rel[k], ratio: res.rel[k] / b })).map(r => ({ ...r, ok: r.ratio >= 1 - (base.maxSlowdown ?? MAX_SLOWDOWN) }));
let rows = check(attempts[0]);
if (rows.some(r => !r.ok)) { console.log('regression on first attempt, retrying once to rule out noise...'); attempts.push(run()); const best = Object.fromEntries(Object.keys(base.rel).map(k => [k, Math.max(...attempts.map(a => a.rel[k]))])); rows = check({ rel: best }); }
console.log('benchmark'.padEnd(14), 'relative ops'.padStart(14), 'baseline'.padStart(12), 'vs baseline'.padStart(12));
for (const r of rows) console.log(r.k.padEnd(14), r.now.toFixed(4).padStart(14), r.base.toFixed(4).padStart(12), ((r.ratio - 1) * 100).toFixed(1).padStart(10) + '%', r.ok ? '' : ' REGRESSION');
if (rows.some(r => !r.ok)) { console.error(`\nBENCH GATE FAILED: more than ${MAX_SLOWDOWN * 100}% slower than baseline`); process.exit(1); }
console.log('\nbench gate OK');
