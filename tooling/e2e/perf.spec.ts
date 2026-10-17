/**
 * Gate: Speed (interaction budgets). 1,000 history records (the app's cap), a mix of brews and espresso shots with curves,
 * CPU throttled 4x. Opening History must render in < 300 ms (median of 5), and scrolling must produce no long task (> 50 ms).
 * Budgets live in tooling/budgets.json.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, seed, waitStage } from '../lib/test';
import { baseSeed, history } from '../lib/data';

const B = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'budgets.json'), 'utf8')).interaction;

async function loadThrottled(page: Page) {
  await page.addInitScript(() => {
    (window as any).__long = [];
    try {
      new PerformanceObserver(l => { for (const e of l.getEntries()) (window as any).__long.push({ d: Math.round(e.duration), t: Math.round(e.startTime) }); }).observe({ type: 'longtask', buffered: true });
    } catch { /* longtask unsupported */ }
  });
  await seed(page, baseSeed({ history: history(B.records, 3) }));
  await page.goto('/index.html');
  await waitStage(page, 'today');
  const count = await page.evaluate(() => JSON.parse(localStorage.getItem('bloom.history.v1') || '[]').length);
  expect(count).toBe(B.records);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: B.cpuThrottle });
  return cdp;
}

/** Click -> frame after the DOM is built and laid out (click handler + render + style/layout/paint), in ms. */
const openHistory = (page: Page) => page.evaluate(() => new Promise<number>(res => {
  const t0 = performance.now();
  (document.getElementById('historyBtn') as HTMLButtonElement).click();
  requestAnimationFrame(() => requestAnimationFrame(() => res(performance.now() - t0)));
}));

test.describe('1,000-record history at 4x CPU throttle', () => {
  test.use({ collectCoverage: false });

  test('opening History renders in under 300 ms (median of 5)', async ({ page }) => {
    // KNOWN-BUG: measured median ~1.9 s at 4x throttle (~0.45 s unthrottled). renderHistory() rebuilds all 1,000 <details> rows
    // (with nested DOM and an espresso curve chart per shot) synchronously on every open. Fix: render the first screenful and the rest
    // lazily (IntersectionObserver / chunked requestIdleCallback), or build the heavy body only when a row is expanded. Then delete
    // test.fail() so the budget is enforced.
    test.fail();
    test.setTimeout(180_000);
    await loadThrottled(page);
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      await page.click('#homeBtn'); await waitStage(page, 'today'); await page.waitForTimeout(700);
      times.push(Math.round(await openHistory(page)));
      await waitStage(page, 'history');
    }
    const median = [...times].sort((a, b) => a - b)[2];
    console.log(`[perf] history open times (ms): ${times.join(', ')}; median ${median}`);
    test.info().annotations.push({ type: 'measured', description: `History open (1000 records, ${B.cpuThrottle}x CPU): ${times.join(', ')} ms, median ${median} ms` });
    expect(median, `History open median ${median} ms (all: ${times.join(', ')})`).toBeLessThan(B.historyOpenMs);
  });

  test('scrolling the full list produces no long tasks (> 50 ms)', async ({ page }) => {
    // KNOWN-BUG: two ~530 ms long tasks (at 4x throttle) while wheel-scrolling through the 1,000-row list. Same root cause as the slow open:
    // 1,000 <details> rows with heavy bodies force large style/layout work as the viewport moves (no containment / virtualisation).
    // Fix: render rows lazily and add `content-visibility: auto; contain-intrinsic-size` to .hist > li. Then delete test.fail().
    test.fail();
    test.setTimeout(180_000);
    await loadThrottled(page);
    await page.click('#historyBtn');
    await waitStage(page, 'history');
    await expect.poll(() => page.locator('#histList > li').count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(B.records);
    await page.waitForTimeout(800); // let the open itself (a legitimate long task) finish before measuring the scroll
    await page.evaluate(() => { (window as any).__long.length = 0; });
    await page.mouse.move(200, 400);
    for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, 1200); await page.waitForTimeout(40); }
    await page.waitForTimeout(300);
    const long = await page.evaluate(() => (window as any).__long as { d: number; t: number }[]);
    console.log(`[perf] long tasks while scrolling: ${long.length}${long.length ? ' ' + JSON.stringify(long.slice(0, 5)) : ''}`);
    expect(long.filter(l => l.d > B.longTaskMs), `long tasks during scroll: ${JSON.stringify(long)}`).toEqual([]);
  });
});
