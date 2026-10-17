/**
 * Gate: Resource efficiency. Memory-leak loop with CDP, idle CPU (no recurring timers / rAF loops), and sync polling that stops when
 * the page is hidden. Budgets live in tooling/budgets.json.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CDPSession, Page } from '@playwright/test';
import { test, expect, seed, waitStage, nav, activeStage } from '../lib/test';
import { baseSeed, FIXED_NOW } from '../lib/data';

const M = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'budgets.json'), 'utf8')).memory;

async function snapshot(cdp: CDPSession) {
  // three GC passes, with a short pause so weak refs / finalisers settle
  for (let i = 0; i < 3; i++) { await cdp.send('HeapProfiler.collectGarbage'); await new Promise(r => setTimeout(r, 60)); }
  const heap = await cdp.send('Runtime.getHeapUsage');
  const dom = await cdp.send('Memory.getDOMCounters');
  return { heap: heap.usedSize as number, nodes: dom.nodes as number, listeners: dom.jsEventListeners as number, documents: dom.documents as number };
}

async function lap(page: Page) {
  // today -> recipe -> brew start/stop -> history open/close -> settings open/close
  await page.click('#todayAdjust'); await waitStage(page, 'recipe');
  await page.click('#nextBtn'); await waitStage(page, 'brew');
  await page.click('#playBtn'); await page.locator('#pauseBtn').waitFor();
  await page.click('#backBtn'); // "Tap again to cancel"
  await page.click('#backBtn'); await waitStage(page, 'recipe'); // cancel returns to the recipe
  await page.click('#backBtn'); await waitStage(page, 'today');
  await nav(page, 'history'); await page.locator('#histList > li summary').first().click();
  await page.click('#nextBtn'); await waitStage(page, 'today'); // Close
  await nav(page, 'settings'); await page.click('#nextBtn'); await waitStage(page, 'today');
}

test.describe('memory', () => {
  test.use({ collectCoverage: false });

  test(`navigation loop x${M.loops}: heap returns to baseline and DOM/listeners do not accumulate`, async ({ page }) => {
    test.setTimeout(240_000);
    await seed(page, baseSeed());
    await page.goto('/index.html');
    await waitStage(page, 'today');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('HeapProfiler.enable');
    await cdp.send('Performance.enable');

    // warm-up: JIT, lazy caches and one-time allocations are not leaks
    for (let i = 0; i < 3; i++) await lap(page);
    await page.waitForTimeout(800);
    const base = await snapshot(cdp);
    for (let i = 0; i < M.loops; i++) await lap(page);
    await page.waitForTimeout(800);
    const end = await snapshot(cdp);

    const growth = end.heap - base.heap;
    const nodePct = ((end.nodes - base.nodes) / base.nodes) * 100;
    const listenerDelta = end.listeners - base.listeners;
    const msg = `heap ${(base.heap / 1048576).toFixed(2)} -> ${(end.heap / 1048576).toFixed(2)} MB (growth ${(growth / 1024).toFixed(0)} KB); DOM nodes ${base.nodes} -> ${end.nodes} (${nodePct.toFixed(2)}%); listeners ${base.listeners} -> ${end.listeners}; documents ${base.documents} -> ${end.documents}`;
    console.log('[memory] ' + msg);
    test.info().annotations.push({ type: 'measured', description: msg });

    expect(growth, msg).toBeLessThan(M.maxHeapGrowthBytes);
    expect(nodePct, msg).toBeLessThan(M.maxDomNodeGrowthPct);
    expect(listenerDelta, msg).toBeLessThanOrEqual(M.maxListenerGrowth);
    expect(end.documents, msg).toBeLessThanOrEqual(base.documents);
    expect(await activeStage(page)).toBe('today');
  });
});

test.describe('idle CPU', () => {
  test.use({ collectCoverage: false });

  async function instrument(page: Page) {
    await page.addInitScript(() => {
      const w = window as any;
      w.__t = { intervalsLive: new Set<number>(), intervalFires: 0, rafFires: 0, timeoutFires: 0, timeoutsSet: 0 };
      const si = w.setInterval.bind(w), ci = w.clearInterval.bind(w), st = w.setTimeout.bind(w), raf = w.requestAnimationFrame.bind(w);
      w.setInterval = (fn: any, ms?: number, ...a: any[]) => { const id = si((...x: any[]) => { w.__t.intervalFires++; return fn(...x); }, ms, ...a); w.__t.intervalsLive.add(id); return id; };
      w.clearInterval = (id: number) => { w.__t.intervalsLive.delete(id); return ci(id); };
      w.setTimeout = (fn: any, ms?: number, ...a: any[]) => { if (typeof fn !== 'function') return st(fn, ms); w.__t.timeoutsSet++; return st((...x: any[]) => { w.__t.timeoutFires++; return fn(...x); }, ms, ...a); };
      w.requestAnimationFrame = (fn: FrameRequestCallback) => raf((t: number) => { w.__t.rafFires++; fn(t); });
    });
  }
  const read = (page: Page) => page.evaluate(() => { const t = (window as any).__t; return { intervalsLive: t.intervalsLive.size, intervalFires: t.intervalFires, rafFires: t.rafFires, timeoutFires: t.timeoutFires }; });

  test('with nothing running, Today schedules no recurring timers or animation-frame loops over 10 s', async ({ page }) => {
    await page.clock.install({ time: new Date(FIXED_NOW) });
    await instrument(page);
    await seed(page, baseSeed());
    await page.goto('/index.html');
    await waitStage(page, 'today');
    await page.clock.runFor(2_000); // let one-off start-up work (transitions, debounced saves) finish
    const a = await read(page);
    await page.clock.runFor(10_000); // 10 s of page time, delivered deterministically
    const b = await read(page);
    const d = { intervalsLive: b.intervalsLive, intervalFires: b.intervalFires - a.intervalFires, rafFires: b.rafFires - a.rafFires, timeoutFires: b.timeoutFires - a.timeoutFires };
    console.log('[idle] ' + JSON.stringify(d));
    expect(d.intervalsLive, 'live setInterval timers while idle').toBe(0);
    expect(d.intervalFires, 'interval callbacks in 10 s').toBe(0);
    expect(d.rafFires, 'requestAnimationFrame callbacks in 10 s').toBe(0);
    expect(d.timeoutFires, 'setTimeout callbacks in 10 s (a recurring timeout chain would show here)').toBe(0);
  });

  test('the brew loops stop when the brew is cancelled (nothing left running on Today afterwards)', async ({ page }) => {
    await page.clock.install({ time: new Date(FIXED_NOW) });
    await instrument(page);
    await seed(page, baseSeed());
    await page.goto('/index.html');
    await waitStage(page, 'today');
    await page.click('#todayBrew'); await waitStage(page, 'brew');
    await page.click('#playBtn'); await page.locator('#pauseBtn').waitFor();
    await page.clock.runFor(1_000);
    expect((await read(page)).intervalsLive).toBeGreaterThan(0);
    await page.click('#backBtn'); await page.click('#backBtn'); await waitStage(page, 'today');
    await page.clock.runFor(2_000);
    const a = await read(page);
    await page.clock.runFor(10_000);
    const b = await read(page);
    expect(b.intervalsLive).toBe(0);
    expect(b.rafFires - a.rafFires).toBe(0);
    expect(b.intervalFires - a.intervalFires).toBe(0);
  });

  test('the sync adapter polls while visible and stops polling while the page is hidden', async ({ page }) => {
    test.setTimeout(60_000);
    await page.clock.install({ time: new Date('2026-10-17T08:00:00Z') });
    // A same-origin document with no app on it: only bloom-sync.js is loaded, against a fake network.
    await page.goto('/vendor/bloom-slog.js');
    await page.addScriptTag({ url: '/bloom-sync.js' });
    const calls = await page.evaluate(async () => {
      const w = window as any;
      const log: string[] = [];
      w.__calls = log;
      const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
      const fetchFake = async (url: string) => {
        log.push(new URL(url).pathname);
        if (url.includes('/v1/auth/signup')) return json({ token: 'tok', expiresAt: Date.now() + 1e9, user: { id: 'u1', email: 'a@example.com', name: 'A' } });
        return json({ docs: [], changes: [], cursor: 0, seq: 0, more: false, hasMore: false });
      };
      w.BloomSync.configure({ baseUrl: 'http://sync.test', pollMs: 1000, kdfIterations: 1000, minKdfIterations: 1000, fetch: fetchFake });
      await w.BloomSync.auth.signup('a@example.com', 'correct horse battery', 'A');
      const db = await w.BloomSync.use('db');
      db.doc('data/users/u1/x').collection('c').onSnapshot(() => {}, () => {});
      return log.length;
    });
    expect(calls).toBeGreaterThan(0);
    const polls = async (ms: number) => { const before = await page.evaluate(() => (window as any).__calls.filter((p: string) => p.startsWith('/v1/sync')).length); await page.clock.runFor(ms); return (await page.evaluate(() => (window as any).__calls.filter((p: string) => p.startsWith('/v1/sync')).length)) - before; };
    const visible = await polls(5_000);
    expect(visible, 'sync polls in 5 s while visible (pollMs=1000)').toBeGreaterThanOrEqual(3);

    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const hidden = await polls(30_000);
    expect(hidden, 'sync polls in 30 s while the page is hidden').toBe(0);

    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(await polls(3_000), 'polling resumes when visible again').toBeGreaterThanOrEqual(2);
  });
});
