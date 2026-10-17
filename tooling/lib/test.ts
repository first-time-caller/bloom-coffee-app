import { test as base, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Seed } from './data';

const here = dirname(fileURLToPath(import.meta.url));
export const RAW_COVERAGE_DIR = join(here, '..', 'coverage', 'raw');

export type NetLog = { all: string[]; external: string[] };

type Fixtures = {
  /** Record every request and answer third-party ones with an empty 200, so tests are hermetic and the privacy gate can still see the attempt. */
  net: NetLog;
  collectCoverage: boolean;
  page: Page;
};

export const test = base.extend<Fixtures>({
  collectCoverage: [true, { option: true }],
  net: async ({}, use) => { await use({ all: [], external: [] }); },
  page: async ({ page, net, baseURL, collectCoverage }, use, testInfo) => {
    const origin = new URL(baseURL!).origin;
    page.on('request', r => {
      const u = r.url();
      if (u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('about:')) return;
      net.all.push(u);
      if (new URL(u).origin !== origin) net.external.push(u);
    });
    await page.route(u => new URL(u).origin !== origin && /^https?:$/.test(new URL(u).protocol), route => {
      const t = route.request().resourceType();
      return route.fulfill({ status: 200, contentType: t === 'stylesheet' ? 'text/css' : 'text/plain', body: '' });
    });
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    const doCov = collectCoverage && process.env.E2E_COVERAGE === '1'; // precise coverage slows pages down: only the reliability run enables it
    if (doCov) await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: false });
    await use(page);
    if (doCov) {
      try {
        const entries = await page.coverage.stopJSCoverage();
        mkdirSync(RAW_COVERAGE_DIR, { recursive: true });
        writeFileSync(join(RAW_COVERAGE_DIR, `${randomUUID()}.json`), JSON.stringify(entries.map(e => ({ url: e.url, source: e.source, functions: e.functions }))));
      } catch { /* page closed early */ }
    }
    if (!testInfo.annotations.some(a => a.type === 'allow-page-errors')) expect(errors, 'uncaught page errors').toEqual([]);
  }
});

export { expect };

/** Seed localStorage once per tab (sessionStorage flag), so reloads in the test keep what the app wrote. */
export async function seed(page: Page, s: Seed) {
  await page.addInitScript((s: Seed) => {
    try {
      if (sessionStorage.getItem('__seeded')) return;
      sessionStorage.setItem('__seeded', '1');
      localStorage.clear();
      if (s.name) localStorage.setItem('bloom.name', JSON.stringify({ name: s.name, set: true }));
      if (s.pro) localStorage.setItem('bloom.settings.v1', JSON.stringify({ pro: true }));
      if (s.bags) { localStorage.setItem('bloom.bags.v1', JSON.stringify(s.bags)); if (s.bags[0]) localStorage.setItem('bloom.todayBag', JSON.stringify(s.bags[0].id)); }
      if (s.history) localStorage.setItem('bloom.history.v1', JSON.stringify(s.history));
      for (const [k, v] of Object.entries(s.extra || {})) localStorage.setItem(k, JSON.stringify(v));
    } catch { /* storage blocked */ }
  }, s);
}

export async function activeStage(page: Page): Promise<string> {
  return page.evaluate(() => (document.querySelector('.stage[data-pos="active"]') as HTMLElement | null)?.dataset.stage || '');
}
export async function waitStage(page: Page, name: string) {
  // Polled from Node: page.waitForFunction polls with rAF, which a faked page.clock would freeze.
  await expect.poll(() => activeStage(page), { message: `waiting for stage "${name}"`, timeout: 10_000 }).toBe(name);
}
/** Click a header nav button (Shelf/History/Settings) and wait for the stage. */
export async function nav(page: Page, which: 'shelf' | 'history' | 'settings') {
  await page.click(`#${which}Btn`);
  await waitStage(page, which);
}
/** Today -> brew (not started). "Start brewing" on Today goes straight to the brew screen. Requires a seeded bag. */
export async function openBrew(page: Page) {
  await waitStage(page, 'today');
  await page.click('#todayBrew');
  await waitStage(page, 'brew');
}
export async function startBrew(page: Page) {
  await openBrew(page);
  await page.click('#playBtn');
  await expect(page.locator('#pauseBtn')).toBeVisible();
}
/** Go to the Today screen from wherever, using the mark button. */
export async function home(page: Page) {
  await page.click('#homeBtn');
}

/** Drive a running brew to the end by jumping the (faked) clock and ticking manual steps. Requires page.clock.install() before load. */
export async function finishBrew(page: Page) {
  for (let i = 0; i < 40 && (await activeStage(page)) === 'brew'; i++) {
    await page.clock.fastForward(15_000);
    const play = page.locator('#playBtn');
    const label = (await play.textContent()) || '';
    if (/Poured|Water is gone|Done|Finish/i.test(label) && (await play.isVisible())) await play.click({ timeout: 2000 }).catch(() => {});
  }
  await waitStage(page, 'done');
}
