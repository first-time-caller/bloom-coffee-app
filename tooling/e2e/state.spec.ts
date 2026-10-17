/**
 * Gate: Predictable state. What the app persists and promises, tested with a controllable clock (page.clock), never real sleeps.
 *  - the brew timer survives backgrounding (elapsed follows the clock, not the frame rate)
 *  - a hard reload mid-brew offers to resume with the correct elapsed time
 *  - same seed + same clock => identical UI state and pixels
 *  - unsaved form drafts (NOT promised by the app today: recorded as KNOWN-BUG gaps)
 */
import { writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect, seed, startBrew, waitStage, nav, activeStage } from '../lib/test';
import { baseSeed, FIXED_NOW } from '../lib/data';

const T0 = new Date(FIXED_NOW);

/** Pixel comparison that ignores 1-2 level anti-aliasing noise from the rasteriser but not any visible change. Done in a scratch page via canvas. */
async function pixelDiff(page: Page, a: string, b: string) {
  return page.evaluate(async ([x, y]) => {
    const load = (b64: string) => new Promise<ImageData>((res, rej) => {
      const img = new Image();
      img.onload = () => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d')!; g.drawImage(img, 0, 0); res(g.getImageData(0, 0, img.width, img.height)); };
      img.onerror = rej; img.src = 'data:image/png;base64,' + b64;
    });
    const [p, q] = [await load(x), await load(y)];
    if (p.width !== q.width || p.height !== q.height) return { sizeMismatch: true, max: 255, over: -1 };
    let max = 0, over = 0;
    for (let i = 0; i < p.data.length; i += 4) {
      const d = Math.max(Math.abs(p.data[i] - q.data[i]), Math.abs(p.data[i + 1] - q.data[i + 1]), Math.abs(p.data[i + 2] - q.data[i + 2]));
      if (d > max) max = d;
      if (d > 8) over++;
    }
    return { sizeMismatch: false, max, over };
  }, [a, b] as const);
}
const mmss = (t: string) => { const m = t.trim().match(/^(\d+):(\d{2})$/); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
const elapsedOnScreen = async (page: Page) => mmss((await page.locator('#stepCount').textContent()) || '');
/** Foreground time passing: one-second steps so the app's 500 ms interval and animation frames keep ticking, as in a real browser. */
async function advance(page: Page, seconds: number) { for (let i = 0; i < seconds; i++) await page.clock.fastForward(1_000); }
/** The resume offer exists on both the welcome and today screens; the visible one is on the active stage. */
const resumeBar = (page: Page) => page.locator('.stage[data-pos="active"] .resume');

async function setHidden(page: Page, hidden: boolean) {
  await page.evaluate(h => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

test.describe('brew timer', () => {
  test.beforeEach(async ({ page }) => {
    page.on('dialog', d => d.accept()); // the app asks "A brew is still running" on unload
    await page.clock.install({ time: T0 });
    await seed(page, baseSeed());
    await page.goto('/index.html');
  });

  test('backgrounding for 5 s does not lose time: elapsed matches the clock within 1 s', async ({ page }) => {
    await startBrew(page);
    await page.clock.fastForward(2_000);
    await expect.poll(() => elapsedOnScreen(page)).toBeGreaterThanOrEqual(1);
    const before = await elapsedOnScreen(page);

    await setHidden(page, true);
    await page.clock.fastForward(5_000); // time passes while the tab is hidden
    await setHidden(page, false);

    const expected = before + 5;
    await expect.poll(() => elapsedOnScreen(page), { message: `expected ~${expected}s on screen` }).toBeGreaterThanOrEqual(expected - 1);
    expect(await elapsedOnScreen(page)).toBeLessThanOrEqual(expected + 1);
    // absolute check against the clock: play was pressed at T0 (+ setup), 7 s have passed since
    expect(await page.evaluate(() => Date.now() - Date.parse('2026-10-17T08:00:00.000Z'))).toBeGreaterThanOrEqual(7_000);
  });

  test('hard reload mid-brew offers to resume, and resuming shows the right elapsed time (including time away)', async ({ page }) => {
    await startBrew(page);
    await advance(page, 20);
    await expect.poll(() => elapsedOnScreen(page)).toBeGreaterThanOrEqual(19);
    await page.clock.fastForward(10_000); // "the phone was locked" for 10 s ...
    await expect.poll(() => elapsedOnScreen(page)).toBeGreaterThanOrEqual(29);
    await page.reload(); // ... and the tab was reloaded

    const bar = resumeBar(page);
    await expect(bar).toBeVisible();
    await expect(bar).toContainText('Brew in progress');
    const barSeconds = mmss((await bar.locator('b').textContent())!.replace(/.* at /, ''));
    expect(Math.abs(barSeconds - 30)).toBeLessThanOrEqual(1);

    await bar.getByRole('button', { name: 'Resume' }).click();
    await waitStage(page, 'brew');
    await expect(page.locator('#pauseBtn')).toBeVisible(); // still running
    expect(Math.abs((await elapsedOnScreen(page)) - 30)).toBeLessThanOrEqual(1);
    await advance(page, 5);
    await expect.poll(() => elapsedOnScreen(page)).toBeGreaterThanOrEqual(34);
  });

  test('a paused brew stays paused across a reload (time away does not count)', async ({ page }) => {
    await startBrew(page);
    await advance(page, 12);
    await page.click('#pauseBtn');
    await expect(page.locator('#playBtn')).toBeVisible();
    const paused = await elapsedOnScreen(page);
    await page.clock.fastForward(60_000);
    await page.reload();
    await resumeBar(page).getByRole('button', { name: 'Resume' }).click();
    await waitStage(page, 'brew');
    expect(Math.abs((await elapsedOnScreen(page)) - paused)).toBeLessThanOrEqual(1);
    await expect(page.locator('#pauseBtn')).toBeHidden(); // still paused
  });

  test('discarding the offer forgets the brew', async ({ page }) => {
    await startBrew(page);
    await advance(page, 8);
    await page.reload();
    await resumeBar(page).getByRole('button', { name: 'Discard' }).click();
    await expect(page.locator('.resume')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('bloom.brew.inflight'))).toBeNull();
  });

  test('a brew left for more than two hours is not offered', async ({ page }) => {
    await startBrew(page);
    await advance(page, 8);
    await page.clock.fastForward(2 * 3600_000 + 60_000);
    await page.reload();
    await waitStage(page, 'today');
    await expect(page.locator('.resume')).toHaveCount(0);
  });
});

test.describe('persisted data', () => {
  test('history, bags, name and settings survive a reload byte-for-byte', async ({ page }) => {
    await page.clock.install({ time: T0 });
    await seed(page, baseSeed());
    await page.goto('/index.html');
    await waitStage(page, 'today');
    const keys = ['bloom.history.v1', 'bloom.bags.v1', 'bloom.name', 'bloom.settings.v1'];
    const snap = () => page.evaluate(k => k.map(x => localStorage.getItem(x)), keys);
    const a = await snap();
    await page.reload();
    await waitStage(page, 'today');
    await nav(page, 'history');
    const b = await snap();
    expect(b[0]).toBe(a[0]); // history
    expect(b[2]).toBe(a[2]); // name
    expect(JSON.parse(b[1]!).map((x: any) => x.id)).toEqual(JSON.parse(a[1]!).map((x: any) => x.id)); // bags: ids stable (timestamps may be touched)
  });
});

test.describe('determinism', () => {
  test('same seed + same clock => identical UI text, accessibility tree and pixels across two runs', async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    const run = async () => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US', timezoneId: 'UTC', deviceScaleFactor: 1, serviceWorkers: 'block', reducedMotion: 'reduce' });
      const page = await ctx.newPage();
      await page.route(u => new URL(u).origin !== new URL(baseURL!).origin && /^https?:$/.test(new URL(u).protocol), r => r.fulfill({ status: 200, body: '', contentType: 'text/css' }));
      await page.clock.install({ time: T0 });
      await seed(page, baseSeed());
      await page.goto('/index.html');
      await waitStage(page, 'today');
      const out: Record<string, unknown> = {};
      const grab = async (id: string) => {
        await page.waitForTimeout(800);
        out[`${id}.text`] = await page.evaluate(() => (document.querySelector('.stage[data-pos="active"]') as HTMLElement).innerText);
        out[`${id}.aria`] = await page.locator('.stage[data-pos="active"]').ariaSnapshot();
        out[`${id}.png`] = (await page.screenshot({ animations: 'disabled', caret: 'hide' })).toString('base64');
      };
      await grab('today');
      await nav(page, 'history'); await page.locator('#histList > li summary').first().click(); await grab('history');
      await page.click('#homeBtn'); await waitStage(page, 'today');
      await nav(page, 'shelf'); await grab('shelf');
      await page.click('#homeBtn'); await waitStage(page, 'today');
      await nav(page, 'settings'); await grab('settings');
      out.storage = await page.evaluate(() => JSON.stringify(Object.keys(localStorage).sort().map(k => [k, k === 'bloom.settings.v1' ? JSON.parse(localStorage.getItem(k)!).pro : localStorage.getItem(k)?.length])));
      await ctx.close();
      return out;
    };
    const [a, b] = [await run(), await run()];
    for (const k of Object.keys(a)) {
      if (k.endsWith('.png')) {
        if (a[k] !== b[k]) { writeFileSync(test.info().outputPath(`${k}-run1.png`), Buffer.from(a[k] as string, 'base64')); writeFileSync(test.info().outputPath(`${k}-run2.png`), Buffer.from(b[k] as string, 'base64')); }
        const scratch = await browser.newPage();
        const diff = await pixelDiff(scratch, a[k] as string, b[k] as string);
        await scratch.close();
        expect(diff, `screenshot ${k} differs between runs (max channel delta ${diff.max}, ${diff.over} pixels beyond tolerance 8)`).toMatchObject({ sizeMismatch: false, over: 0 });
      }
      else expect(b[k], k).toEqual(a[k]);
    }
  });
});

test.describe('unsaved drafts', () => {
  // KNOWN-BUG (gap, not a promise): the app keeps no drafts. Typing a name or filling a log/shot form and then reloading (or the OS
  // killing the tab in the background, which is routine on phones) discards the input. Only an in-flight brew is persisted.
  // These tests describe the behaviour users expect; they are expected to fail until drafts are saved (then remove test.fail()).
  test('welcome: a half-typed name survives a reload', async ({ page }) => {
    test.fail();
    await page.goto('/index.html');
    await waitStage(page, 'welcome');
    await page.fill('#nameInput', 'Grac');
    await page.reload();
    await waitStage(page, 'welcome');
    await expect(page.locator('#nameInput')).toHaveValue('Grac');
  });

  test('espresso shot form: entered dose/yield/time survive a reload', async ({ page }) => {
    test.fail();
    await seed(page, baseSeed());
    await page.goto('/index.html');
    await nav(page, 'history');
    await page.click('#shotBtn');
    await waitStage(page, 'shot');
    await page.fill('#shotDose', '18.5');
    await page.fill('#shotYield', '37');
    await page.fill('#shotTime', '29');
    await page.reload();
    expect(await activeStage(page)).toBe('shot');
    await expect(page.locator('#shotDose')).toHaveValue('18.5');
  });

  test('log a coffee form: typed variety and notes survive a reload', async ({ page }) => {
    test.fail();
    await seed(page, baseSeed());
    await page.goto('/index.html');
    await nav(page, 'history');
    await page.click('#logBtn');
    await waitStage(page, 'log');
    await page.fill('#logRoaster', 'Round Hill');
    await page.fill('#logNote', 'At the market');
    await page.reload();
    expect(await activeStage(page)).toBe('log');
    await expect(page.locator('#logNote')).toHaveValue('At the market');
  });
});
