/**
 * Gate: Reliability. The full journey, first run to history, with no uncaught errors. This spec also drives the V8 coverage
 * numbers for the inline app script (see scripts/coverage-check.mjs).
 */
import { test, expect, waitStage, nav, activeStage } from '../lib/test';
import { FIXED_NOW } from '../lib/data';

test.describe('full journey', () => {
  test('first run: welcome, add a bag, brew to the end, rate, see it in history', async ({ page }) => {
    await page.clock.install({ time: new Date(FIXED_NOW) });
    await page.goto('/index.html');
    await waitStage(page, 'welcome');

    await page.fill('#nameInput', 'Ada');
    await page.click('#nextBtn');
    await waitStage(page, 'today');
    await expect(page.locator('#h-today')).toContainText(/Ada|Good/);

    await page.click('#todayAddBag');
    await waitStage(page, 'coffee');
    await page.fill('#roasterIn', 'Onyx');
    await page.fill('#nameIn', 'Geometry');
    await page.fill('#roastDate', '2026-10-05');
    await page.click('[data-roast=light]');
    await page.click('#nextBtn');
    await waitStage(page, 'method');
    await page.locator('#methodRows [role=radio]').first().click();
    await page.click('#nextBtn');
    await waitStage(page, 'yield');
    await page.click('#yieldPlus');
    await page.click('#nextBtn');
    await waitStage(page, 'recipe');
    await expect(page.locator('#pourList li').first()).toBeVisible();
    await page.click('#nextBtn');
    await waitStage(page, 'brew');
    await page.click('#playBtn');

    for (let i = 0; i < 30 && (await activeStage(page)) === 'brew'; i++) {
      await page.clock.fastForward(15_000); // jump (fires due timers once): runFor would replay ~900 animation frames
      const label = (await page.locator('#playBtn').textContent()) || '';
      if (/Poured|Water is gone/.test(label) && (await page.locator('#playBtn').isVisible())) await page.click('#playBtn', { timeout: 2000 }).catch(() => {});
    }
    await waitStage(page, 'done');
    await page.locator('#doneRating button').nth(3).click();
    await page.click('#nextBtn'); // Back to today
    await waitStage(page, 'today');

    await nav(page, 'history');
    await expect(page.locator('#histList > li')).toHaveCount(1);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('bloom.history.v1') || '[]'));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ roaster: 'Onyx', method: 'v60', rating: 4 });
  });

  test('log a coffee and an espresso shot, browse shelf and settings', async ({ page }) => {
    const { seed } = await import('../lib/test');
    const { baseSeed } = await import('../lib/data');
    await seed(page, baseSeed({ history: [] }));
    await page.goto('/index.html');
    await waitStage(page, 'today');

    await nav(page, 'history');
    await page.click('#logBtn');
    await waitStage(page, 'log');
    await page.fill('#logVariety', 'Gesha');
    await page.keyboard.press('Enter');
    await page.fill('#logRoaster', 'A cafe');
    await page.click('#nextBtn');
    await waitStage(page, 'history');
    await expect(page.locator('#histList > li')).toHaveCount(1);

    await page.click('#shotBtn');
    await waitStage(page, 'shot');
    await page.fill('#shotDose', '18');
    await page.fill('#shotYield', '36');
    await page.fill('#shotTime', '28');
    await expect(page.locator('#shotRatio')).toContainText('2');
    await page.click('#nextBtn');
    await waitStage(page, 'history');
    await expect(page.locator('#histList > li')).toHaveCount(2);

    await page.click('#homeBtn');
    await waitStage(page, 'today');
    await nav(page, 'shelf');
    await expect(page.locator('#h-shelf')).toBeVisible();
    await page.click('#nextBtn');
    await nav(page, 'settings');
    await expect(page.locator('#h-settings')).toBeVisible();
    await page.click('#nextBtn');
    await waitStage(page, 'today');
  });

  test('reload keeps the data (local-first)', async ({ page }) => {
    const { seed } = await import('../lib/test');
    const { baseSeed } = await import('../lib/data');
    await seed(page, baseSeed());
    await page.goto('/index.html');
    await waitStage(page, 'today');
    await nav(page, 'history');
    await expect(page.locator('#histList > li')).toHaveCount(6);
    await page.reload();
    await waitStage(page, 'today');
    await nav(page, 'history');
    await expect(page.locator('#histList > li')).toHaveCount(6);
  });

  test('closing History after saving a shot returns to Today, not the shot form', async ({ page }) => {
    // KNOWN-BUG: go() records returnTo only when the previous stage is not history/log/settings/shelf. 'shot' is missing from that
    // list, so after Save shot -> History, "Close" sends you back to the (blank) Log a shot form instead of Today.
    test.fail();
    const { seed } = await import('../lib/test');
    const { baseSeed } = await import('../lib/data');
    await seed(page, baseSeed({ history: [] }));
    await page.goto('/index.html');
    await nav(page, 'history');
    await page.click('#shotBtn');
    await waitStage(page, 'shot');
    await page.fill('#shotDose', '18');
    await page.fill('#shotYield', '36');
    await page.click('#nextBtn');
    await waitStage(page, 'history');
    await page.click('#nextBtn'); // Close
    await waitStage(page, 'today');
  });
});
