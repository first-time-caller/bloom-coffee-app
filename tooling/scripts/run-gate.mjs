#!/usr/bin/env node
// Runs one gate (or all of them) and prints a pass / fail / skipped / known-bug summary.
//   node scripts/run-gate.mjs reliability|speed|resources|state|a11y|privacy|all
// Every step runs even if an earlier one fails, so one run shows everything that is red.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const tooling = resolve(here, '..');
const root = resolve(tooling, '..');
const pw = (gate, specs, env = {}) => ({ cmd: 'npx', args: ['playwright', 'test', ...specs], cwd: tooling, env: { PLAYWRIGHT_JSON_OUTPUT_NAME: `test-results/${gate}.json`, ...env }, json: `test-results/${gate}.json` });

const GATES = {
  reliability: [
    { name: 'unit + coverage: packages/slog', cmd: 'npm', args: ['run', '--silent', 'coverage'], cwd: join(root, 'packages/slog') },
    { name: 'unit + coverage: packages/sync', cmd: 'npm', args: ['run', '--silent', 'coverage'], cwd: join(root, 'packages/sync'), optional: true },
    { name: 'unit + coverage: backend', cmd: 'npm', args: ['run', '--silent', 'coverage'], cwd: join(root, 'backend') },
    { name: 'migration lint', cmd: 'node', args: ['scripts/migration-lint.mjs'], cwd: tooling },
    { name: 'migration data preservation + lint self-tests', cmd: 'node', args: ['--no-warnings', '--test', 'scripts/migration-lint.test.mjs', 'scripts/migration-data.test.mjs'], cwd: tooling },
    { name: 'e2e journey (collects V8 coverage)', ...pw('reliability', ['e2e/flow.spec.ts'], { E2E_COVERAGE: '1' }) },
    { name: 'coverage thresholds + ratchet', cmd: 'node', args: ['scripts/coverage-check.mjs'], cwd: tooling }
  ],
  speed: [
    { name: 'bundle size budgets', cmd: 'node', args: ['scripts/bundle-budget.mjs'], cwd: tooling },
    { name: 'Lighthouse CI (mobile, 3 runs, median)', cmd: 'npx', args: ['lhci', 'autorun', '--config=lighthouserc.cjs'], cwd: tooling },
    { name: 'parser benchmark regression (<= 25% slower)', cmd: 'node', args: ['scripts/bench-check.mjs'], cwd: tooling },
    { name: 'history render + scroll at 4x CPU (1000 records)', ...pw('speed', ['e2e/perf.spec.ts']) }
  ],
  resources: [
    { name: 'memory loop, idle CPU, sync polling', ...pw('resources', ['e2e/resources.spec.ts']) },
    { name: 'parser allocation per op', cmd: 'node', args: ['--expose-gc', '--min-semi-space-size=64', '--max-semi-space-size=64', 'scripts/alloc-bench.mjs'], cwd: tooling }
  ],
  state: [{ name: 'state restoration + determinism', ...pw('state', ['e2e/state.spec.ts']) }],
  a11y: [{ name: 'axe, large text, keyboard', ...pw('a11y', ['e2e/a11y.spec.ts']) }],
  privacy: [
    { name: 'secret scan (gitleaks)', cmd: 'node', args: ['scripts/secrets-scan.mjs'], cwd: tooling },
    { name: 'dependency audit', cmd: 'node', args: ['scripts/audit.mjs'], cwd: tooling },
    { name: 'static scan: URLs, analytics, beacons, CSP', cmd: 'node', args: ['scripts/static-scan.mjs'], cwd: tooling },
    { name: 'no third parties at runtime', ...pw('privacy', ['e2e/privacy.spec.ts']) }
  ]
};

const want = process.argv[2] || 'all';
const names = want === 'all' ? Object.keys(GATES) : [want];
if (names.some(n => !GATES[n])) { console.error(`unknown gate "${want}". Choose: ${Object.keys(GATES).join(', ')}, all`); process.exit(2); }
mkdirSync(join(tooling, 'test-results'), { recursive: true });

function knownBugs(jsonPath) {
  const out = [];
  const p = join(tooling, jsonPath);
  if (!existsSync(p)) return out;
  const walk = suite => {
    for (const s of suite.suites ?? []) walk(s);
    for (const spec of suite.specs ?? []) for (const t of spec.tests ?? []) {
      const failedExpected = t.expectedStatus === 'failed' && t.status === 'expected';
      const ann = (t.annotations ?? []).filter(a => a.type === 'known-bug');
      if (failedExpected) out.push(spec.title);
      for (const a of ann) out.push(a.description);
    }
  };
  try { for (const s of JSON.parse(readFileSync(p, 'utf8')).suites ?? []) walk(s); } catch { /* ignore */ }
  return out;
}

const results = [];
for (const g of names) {
  console.log(`\n=================== GATE: ${g} ===================`);
  for (const step of GATES[g]) {
    console.log(`\n--- ${step.name}`);
    if (step.optional && !existsSync(join(step.cwd, 'package.json'))) { results.push({ gate: g, step: step.name, status: 'SKIP', note: 'package not present' }); continue; }
    const t0 = Date.now();
    const r = spawnSync(step.cmd, step.args, { cwd: step.cwd, env: { ...process.env, ...(step.env || {}) }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '');
    const text = (r.stdout || '') + (r.stderr || '');
    const skipped = r.status === 0 && /^SKIPPED/m.test(text);
    const known = step.json ? knownBugs(step.json) : [];
    const extra = /KNOWN-BUG/.test(text) ? (text.match(/KNOWN-BUG [^\n]*/g) || []).map(x => x.slice(0, 120)) : [];
    results.push({ gate: g, step: step.name, status: r.status === 0 ? (skipped ? 'SKIP' : 'PASS') : 'FAIL', secs: Math.round((Date.now() - t0) / 1000), known: [...known, ...extra.filter(e => !known.includes(e))] });
  }
}

console.log('\n\n==================== SUMMARY ====================');
for (const g of names) {
  const rs = results.filter(r => r.gate === g);
  const status = rs.some(r => r.status === 'FAIL') ? 'FAIL' : 'PASS';
  console.log(`\n${g.toUpperCase().padEnd(12)} ${status}`);
  for (const r of rs) {
    console.log(`  ${r.status.padEnd(5)} ${r.step}${r.secs != null ? `  (${r.secs}s)` : ''}${r.note ? `  [${r.note}]` : ''}`);
    for (const k of r.known || []) console.log(`        KNOWN-BUG: ${k}`);
  }
}
writeFileSync(join(tooling, 'test-results/gate-summary.json'), JSON.stringify(results, null, 2));
const failed = results.filter(r => r.status === 'FAIL');
console.log(failed.length ? `\n${failed.length} step(s) FAILED` : '\nall gates passed');
process.exit(failed.length ? 1 : 0);
