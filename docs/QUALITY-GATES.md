# Quality gates

Bloom has six automated gates. Each is a job in `.github/workflows/ci.yml`, all six run in parallel, and all are required to merge. The same checks run locally:

```sh
npm run setup          # once: npm ci in packages/slog, packages/sync, backend, tooling
npm run gates          # every gate, prints a pass / fail / skipped / known-bug summary
npm run gate:speed     # one gate: reliability | speed | resources | state | a11y | privacy
```

Everything cross-cutting lives in `tooling/` (a standalone npm project, like every package here: no workspaces). Browser tests use Playwright 1.56 with the Chromium already installed at `$PLAYWRIGHT_BROWSERS_PATH`. Never run `playwright install` locally; CI does run `npx playwright install --with-deps chromium`. The same `tooling/playwright.config.ts` works in both places.

The web app is served by `tooling/scripts/serve.mjs` (a 60-line static server for `web/`, gzip on, optional `web/_headers` honoured). Tests are hermetic: any request to a host other than the app is recorded and answered with an empty 200, so nothing depends on the internet.

## How the gates treat known defects

A gate never gets weaker to go green. If a gate finds a real defect that is outside the gate's own change, the test stays strict and is marked **`KNOWN-BUG`** (Playwright `test.fail()` with a comment, or an entry in `tooling/known-bugs.json`). While marked, the gate passes and the summary prints the defect; the moment the bug is fixed the test starts "unexpectedly passing" (or the static scan reports a stale entry) and CI turns red until the marker is removed. Known defects therefore cannot linger or hide.

## Gate 1: Reliability

| Check | Threshold | Where |
|---|---|---|
| Unit and integration coverage, `packages/slog` (vitest, v8) | >= 85% lines, branches, functions, statements | `packages/slog/vitest.config.ts` |
| Same, `packages/sync` (the source of `web/bloom-sync.js`) | >= 85% on all four | `packages/sync/vitest.config.ts` |
| Same, `backend/src` (vitest + workers pool) | >= 85% on all four | `backend/vitest.config.ts` |
| Web coverage during the e2e journey (Playwright `page.coverage`, V8) | **ratchet**: may not drop more than 1 point below `tooling/coverage-baseline.json` | `tooling/scripts/coverage-check.mjs` |
| Migration lint | see below | `tooling/scripts/migration-lint.mjs` |
| Migration data preservation | rows written before migration N survive it unchanged | `tooling/scripts/migration-data.test.mjs` |
| E2E journey | first run to brew to history, with no uncaught page errors | `tooling/e2e/flow.spec.ts` |

Run locally: `npm run gate:reliability`. HTML coverage reports land in `*/coverage/lcov-report`.

**Backend coverage uses istanbul, not v8.** The Workers vitest pool runs tests inside `workerd`, which has no `node:inspector`, so `@vitest/coverage-v8` fails there (`No such module "node:inspector/promises"`). `@vitest/coverage-istanbul` instruments the source instead and works.

**Web app coverage is a ratchet, not 85%.** `web/index.html` is one 450 KB inline script, and the end-to-end journey exercises only part of it (it is the only runner that can load that script). The current figures are recorded in `tooling/coverage-baseline.json`; CI fails if they fall. When you add e2e coverage, raise the baseline (`npm --prefix tooling run coverage:baseline`) in the same PR, never lower it. `web/bloom-sync.js` is a minified build of `packages/sync`, so the 85% floor applies to that package's source; the browser-side coverage of the built file is also tracked in the ratchet.

### Migration lint (`backend/migrations/*.sql`)

Forbidden unless the statement is preceded by a reviewed `-- gate:allow-destructive <reason>` comment (a reason is mandatory):

- `DROP TABLE`, `ALTER TABLE ... DROP COLUMN`, `ALTER TABLE ... RENAME` (table or column)
- `DELETE FROM` or `UPDATE` without `WHERE`
- `ADD COLUMN ... NOT NULL` without `DEFAULT`

Also enforced:

- Numbering is sequential `0001_name.sql`, `0002_...`, no gaps or duplicates.
- Migrations already on `main` are immutable. Their SHA-256 is pinned in `tooling/migrations.lock.json`; editing, deleting or renaming a locked file fails the gate. A migration that is not in the lock yet is "pending" (the lint prints a note). After it merges, lock it with `npm --prefix tooling run migrations:lock`. On pull requests, CI additionally fails if `git diff` against the base branch shows any migration that is not purely added.
- `migration-data.test.mjs` builds a SQLite database (node:sqlite, the engine under D1) with migrations 1..N-1, loads representative rows (`tooling/migration-fixtures/NNNN.sql` plus generated rows for any table the fixture does not cover), applies migration N, and asserts every table, column and row survives unchanged and foreign keys are intact. A migration that carries `gate:allow-destructive` is skipped by this test, so the exemption is visible in review.
- `migration-lint.test.mjs` proves each lint rule fires and that the escape hatch works.

## Gate 2: Speed

| Check | Budget | Where |
|---|---|---|
| gzip size, `web/index.html` | 153,200 B (measured 139,266 B + ~10%) | `tooling/budgets.json` |
| gzip size, `web/vendor/bloom-slog.js` | 4,096 B (hard cap from the plan; measured 2,460 B) | same |
| gzip size, `web/bloom-sync.js` | 12,200 B (measured 11,061 B + ~10%) | same |
| gzip size, Worker bundle (`wrangler deploy --dry-run --outdir`) | 47,200 B (measured 42,834 B + ~10%) | same |
| Lighthouse CI, mobile emulation, 3 runs, median | performance >= 90, accessibility >= 95, best-practices >= 95 | `tooling/lighthouserc.cjs` |
| Parser benchmark (vitest `bench`: `parseShot`, `parseIndex`, `shotToCurve`) | not more than 25% slower than baseline | `tooling/bench/`, `scripts/bench-check.mjs` |
| History with 1,000 records, 4x CPU throttle: open History | median of 5 < 300 ms | `tooling/e2e/perf.spec.ts` |
| Same: scroll the whole list | zero long tasks (> 50 ms) | same |

Run: `npm run gate:speed`.

- **Bench robustness.** Each benchmark's ops/sec is divided by a calibration loop's ops/sec measured in the same process, so a slower or noisy CI machine does not matter; only a change in the parser's cost relative to the machine does. A failing comparison is retried once and the better run is used.
- **Lighthouse** uses the preinstalled Chromium locally (`chromePath` is discovered under `$PLAYWRIGHT_BROWSERS_PATH`, or set `CHROME_PATH`) and whatever Chrome `playwright install` provides in CI. Reports are written to `tooling/.lighthouseci/`.
- **Seeded records** come from `tooling/lib/data.ts`, which builds brew records and espresso records with 61-point curves in exactly the shape `cleanRecord` / `espressoRecord` produce.

## Gate 3: Resource efficiency

| Check | Budget | Where |
|---|---|---|
| Memory-leak loop: today, recipe, brew start/stop, history open/close, settings, 20 times; CDP `HeapProfiler.collectGarbage` x3 before each reading, after 3 warm-up loops | JS heap growth < 2 MB; DOM nodes growth < 5%; JS event listeners growth <= 20; no extra documents | `tooling/e2e/resources.spec.ts` |
| Idle CPU: Today with nothing running, 10 s of page time on a controlled clock | 0 live `setInterval`s, 0 interval / `setTimeout` / `requestAnimationFrame` callbacks | same |
| Brew loops stop after cancel | no live interval, no rAF, no interval callbacks afterwards | same |
| Sync polling: `bloom-sync.js` against a fake network, `pollMs=1000` | polls while visible; 0 polls in 30 s while hidden; resumes on show | same |
| Parser allocation per call (shipped bundle, `--expose-gc`, 64 MB young generation so no scavenge runs in the loop) | bytes/op under the budgets in `budgets.json` (`parserAllocation`, measured + 25%) | `tooling/scripts/alloc-bench.mjs` |

Run: `npm run gate:resources`. The tolerances (5% of DOM nodes, 20 listeners) allow for lazily created, cached DOM and one-off listeners; steady growth over 20 laps would exceed them within one or two laps of a real leak. Idle checks use `page.clock` so 10 s of page time is delivered instantly and deterministically.

## Gate 4: Predictable state

`tooling/e2e/state.spec.ts`, no real sleeps (everything uses `page.clock`):

- Background the tab for 5 s (`visibilitychange` to hidden, clock jumps 5 s, back to visible): the displayed elapsed time matches the clock within 1 s.
- Reload mid-brew: the app offers "Brew in progress" with the right elapsed time (including time spent away); Resume restores the running brew; a paused brew stays paused; Discard forgets it; a brew older than 2 h is not offered.
- Persisted data (history, bags, name, settings) survives a reload.
- Determinism: the same seeded `localStorage` and the same clock give identical visible text, accessibility tree and (within 8/255 per channel, to ignore rasteriser anti-aliasing) pixels across two fresh browser contexts, on Today, History (expanded), Shelf and Settings.
- Unsaved drafts: the app does not claim to keep drafts and does not; those tests are `KNOWN-BUG` gaps (see below).

## Gate 5: Accessibility

`tooling/e2e/a11y.spec.ts`:

- axe-core (WCAG 2.0/2.1/2.2 A and AA tags), **zero violations**, on welcome, today, shelf, settings, history (an ordinary entry expanded, and an espresso entry with its curve expanded), log, shot, coffee, method, yield, recipe, brew (idle and running) and done, in light, dark (`emulateMedia colorScheme`) and `forcedColors: 'active'`. Chromium's forced-colors emulation changes the media query but not computed colours, so the `color-contrast` rule is the one rule disabled in that mode.
- Large text: root font-size 200% plus every computed font size doubled (the app sizes text in px, so root scaling alone changes nothing), 375 px wide, every stage: no horizontal overflow, no control clipped by the viewport, every `button` hit target at least 44x44 px.
- Keyboard: Tab through today, recipe, history, shot and settings; every stop has a visible focus indicator, is inside the active screen, and the order never jumps backwards up the page. Enter/Space operate the primary buttons and radios.

## Gate 6: Privacy

| Check | Rule | Where |
|---|---|---|
| Secret scan | gitleaks 8.28.0 (pinned, checksum verified), full history in CI (`fetch-depth: 0`); working tree locally | `.gitleaks.toml`, `tooling/scripts/secrets-scan.mjs` |
| Dependency audit | `npm audit --audit-level=high --omit=dev` per package (blocking); full audit reported to `tooling/audit-reports/` (non-blocking) | `tooling/scripts/audit.mjs` |
| Dependency review | `actions/dependency-review-action` on pull requests, fails on high severity | `ci.yml` job `dependency-review` |
| No third parties at runtime | the whole journey (first run, brew, history, log, shot, shelf, settings, reload) contacts only the app origin plus `tooling/allowed-hosts.json` (empty); no `sendBeacon`, no WebSocket | `tooling/e2e/privacy.spec.ts` |
| Static scan of `web/` | no `http(s)://` host outside the allow-list (XML namespaces ignored), no analytics SDK names, no `sendBeacon` | `tooling/scripts/static-scan.mjs` |
| CSP lint | a Content-Security-Policy exists (meta tag or `web/_headers`), has `default-src` or `script-src`, no `unsafe-eval`, no `unsafe-inline` for scripts, no wildcard sources | same |

Locally the secret scan runs the `gitleaks` binary from `PATH` or `tooling/.bin/` (get it with `npm --prefix tooling run install:gitleaks`), falls back to docker, and otherwise prints `SKIPPED` and moves on; in CI a missing binary is a failure. If gitleaks flags a test fixture, allowlist the narrowest path or regex in `.gitleaks.toml` and explain why in the PR.

To allow a new host: add the exact hostname to `tooling/allowed-hosts.json`. That is a privacy decision, so it needs a reviewer who agrees the data leaving the device is acceptable and the privacy policy says so.

## Baseline measurements (2026-10-17)

| Gate | Measured |
|---|---|
| Coverage | slog 100 / 91.4 / 100 / 100 (lines / branches / functions / statements); sync 99.7 / 88.1 / 98.1 / 99.7; backend/src 99.0 / 89.7 / 98.4 / 97.6; web inline app script in the e2e journey 59.8% of bytes, 56.0% of functions (ratchet); built `bloom-sync.js` in the e2e journey 12.3% bytes (ratchet; the real coverage is the `packages/sync` figure above) |
| Bundles (gzip) | index.html 139.3 KB, bloom-slog.js 2.4 KB, bloom-sync.js 11.1 KB, Worker 42.8 KB |
| Lighthouse (median of 3, mobile) | performance 1.00, accessibility 1.00, best-practices 1.00 (LCP about 1.5 s, TBT 0 ms, CLS 0.002) |
| Parser allocation | parseShot 168 KB/op, parseIndex 1.3 KB/op, shotToCurve 19 KB/op |
| Memory loop (20 laps) | heap +0.25 MB, DOM nodes +0, listeners +0 |
| Idle CPU, 10 s | 0 timers, 0 frames |
| History open, 1,000 records, 4x throttle | median about 1.7 s (budget 300 ms): KNOWN-BUG |

## Known defects the gates currently report

These are real findings, each kept strict and marked so the gate passes but says so on every run. Fixing one makes its marker fail until it is removed.

- **Speed**: opening History with 1,000 records takes about 1.7 s at 4x CPU throttle (budget 300 ms), and wheel-scrolling that list produces two ~550 ms long tasks. (`e2e/perf.spec.ts`)
- **Accessibility, axe**: the History filter chips, the Log-a-shot chips and the Done "buy again" chips are `role="radio"` yet carry `aria-pressed` (not allowed on radios); wrapped chips in Settings > brewers overlap their neighbours (WCAG 2.5.8 target size). (`KNOWN_AXE` in `e2e/a11y.spec.ts`)
- **Accessibility, large text**: at 200% text on a 375 px screen the header nav pushes History and Settings off-screen (page-wide horizontal scroll on every screen); the Yield +/- buttons are pushed off-screen; the Today dose +/- buttons are 31 px wide; the recipe remove-pour buttons are 40x40. (`KNOWN_LARGE`)
- **Accessibility, keyboard**: the notes textarea on Log a shot has no visible focus indicator. (`KNOWN_KEYS`)
- **Predictable state**: the app does not keep unsaved drafts (welcome name, shot form, log form); a reload discards them. This is not something the app promises; the tests record the gap. (`e2e/state.spec.ts`)
- **Navigation**: after saving a shot, History's Close button returns to the blank shot form instead of Today (`returnTo` is not reset when the previous stage is `shot`). (`e2e/flow.spec.ts`)

Fixed while the gates were being written, and removed from the known list: Google Fonts loaded from fonts.googleapis.com / fonts.gstatic.com, and the absence of a Content-Security-Policy.

## Changing a budget deliberately

Budgets are numbers in committed files so every change is a visible diff with a reviewer.

1. Decide whether the regression is real. Try to fix it first.
2. If the new cost is intended, change the number in the **same PR as the feature** and say why in the description (what was added, why it is worth the bytes/time).
3. Use the tool that owns the number:
   - Bundle sizes: edit `gzipBytes` in `tooling/budgets.json`. Keep about 10% headroom over the measured size and update `measuredAtSetup`. `bloom-slog.js` stays at or under 4 KB unless the plan changes.
   - Lighthouse scores: edit `lighthouse` in `tooling/budgets.json`. Lowering a floor needs an explicit owner sign-off.
   - Interaction and memory budgets: edit `interaction` / `memory` in the same file.
   - Parser allocation: `npm --prefix tooling run alloc:baseline` (budget = measured + 25%).
   - Parser speed: `npm --prefix tooling run bench:baseline`.
   - Web coverage ratchet: `npm --prefix tooling run coverage:baseline`. Only raise it.
   - Coverage floors (85%): edit `thresholds` in the package's `vitest.config.ts`. Do not lower them.
   - Migration lock: `npm --prefix tooling run migrations:lock` after the migration merges.
4. Never raise a budget in a drive-by commit, and never delete a failing test; mark it `KNOWN-BUG` with a reason and fix the cause.

## Required checks (branch protection)

Mark these CI checks as required on `main`: `Gate 1: Reliability`, `Gate 2: Speed`, `Gate 3: Resource efficiency`, `Gate 4: Predictable state`, `Gate 5: Accessibility`, `Gate 6: Privacy`, `Gate 6b: Dependency review`. (The last one is skipped on pushes, and a skipped required check counts as passing.)

## Other notes

- Actions are pinned to major versions (`@v4`) and Dependabot (`.github/dependabot.yml`: each npm package and github-actions) keeps them current. Pinning to full commit SHAs is stricter and optional; Dependabot can maintain SHA pins too.
- Workflow permissions are `contents: read` for every job; concurrency cancels superseded runs; Node 22 with the npm cache keyed on the four lockfiles; Playwright browsers are cached.
- Browser timing tests run with one worker so CPU contention does not distort the numbers.
