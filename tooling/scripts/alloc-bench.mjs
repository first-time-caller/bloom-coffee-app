#!/usr/bin/env node
// Resource gate: parser allocation per call. Run with: node --expose-gc --min-semi-space-size=64 --max-semi-space-size=64 scripts/alloc-bench.mjs
// A 64 MB young generation means no scavenge happens during the measured loop, so heapUsed deltas equal bytes allocated.
// Measures the SHIPPED bundle (web/vendor/bloom-slog.js), so a stale or bloated build is caught too.
//   --update   rewrite the budgets in budgets.json (deliberate; see docs/QUALITY-GATES.md)
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (typeof gc !== 'function') { console.error('run with --expose-gc'); process.exit(2); }
const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, '../..');
await import(pathToFileURL(join(root, 'web/vendor/bloom-slog.js')).href);
const { parseShot, parseIndex, shotToCurve } = globalThis.BloomSlog;
const fx = join(root, 'packages/slog/test/fixtures');
const shot = new Uint8Array(readFileSync(join(fx, '000123.slog')));
const index = new Uint8Array(readFileSync(join(fx, 'recent.bin')));
const parsed = parseShot(shot, 123);
const N = 300;
const HEADROOM = 1.25;

function bytesPerOp(fn) {
  for (let i = 0; i < 50; i++) fn(); // warm up (JIT, inline caches)
  const samples = [];
  for (let rep = 0; rep < 5; rep++) {
    gc(); gc();
    const before = process.memoryUsage().heapUsed;
    let sink;
    for (let i = 0; i < N; i++) sink = fn();
    const after = process.memoryUsage().heapUsed;
    if (sink === undefined) throw new Error('unreachable');
    samples.push((after - before) / N);
  }
  samples.sort((a, b) => a - b);
  return Math.round(samples[Math.floor(samples.length / 2)]); // median
}

const measured = {
  parseShot_000123: bytesPerOp(() => parseShot(shot, 123)),
  parseIndex_recent: bytesPerOp(() => parseIndex(index)),
  shotToCurve_000123: bytesPerOp(() => shotToCurve(parsed, 500))
};

const budgetsPath = join(here, '../budgets.json');
const cfg = JSON.parse(readFileSync(budgetsPath, 'utf8'));
if (process.argv.includes('--update')) {
  for (const [k, v] of Object.entries(measured)) cfg.parserAllocation[k] = Math.ceil((v * HEADROOM) / 1024) * 1024;
  cfg.parserAllocation._measured = measured;
  writeFileSync(budgetsPath, JSON.stringify(cfg, null, 2) + '\n');
  console.log('budgets updated', cfg.parserAllocation);
  process.exit(0);
}
let bad = 0;
console.log('operation'.padEnd(22), 'bytes/op'.padStart(10), 'budget'.padStart(10));
for (const [k, v] of Object.entries(measured)) {
  const budget = cfg.parserAllocation[k];
  const ok = budget > 0 && v <= budget;
  if (!ok) bad++;
  console.log(k.padEnd(22), String(v).padStart(10), String(budget).padStart(10), ok ? '' : ' OVER BUDGET');
}
if (bad) { console.error('\nALLOCATION GATE FAILED'); process.exit(1); }
console.log('\nallocation gate OK');
