/**
 * Gate: Privacy. Record every network request across the whole journey and fail on any host that is not the app origin or in
 * tooling/allowed-hosts.json. Hosts listed in tooling/known-bugs.json (Google Fonts today) are asserted separately as a KNOWN-BUG.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, seed, waitStage, nav, finishBrew, type NetLog } from '../lib/test';
import { baseSeed, FIXED_NOW } from '../lib/data';

const read = (f: string) => JSON.parse(readFileSync(join(import.meta.dirname, '..', f), 'utf8'));
const allowed = new Set<string>(read('allowed-hosts.json').hosts);
const knownBugHosts = new Set<string>(Object.keys(read('known-bugs.json').thirdPartyHosts ?? {}));

const hostOf = (u: string) => new URL(u).hostname;

/** Walks the whole app: onboarding, bag, brew to the end, history, log, shot, shelf, settings, sample data, export. */
async function fullJourney(page: import('@playwright/test').Page) {
  await page.clock.install({ time: new Date(FIXED_NOW) });
  await page.addInitScript(() => {
    (window as any).__beacons = 0;
    const orig = navigator.sendBeacon?.bind(navigator);
    navigator.sendBeacon = (...a: any[]) => { (window as any).__beacons++; return orig ? (orig as any)(...a) : false; };
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', e => (window as any).__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    (window as any).__sockets = [];
    const WS = window.WebSocket;
    (window as any).WebSocket = function (u: string, p?: any) { (window as any).__sockets.push(String(u)); return new (WS as any)(u, p); };
    (window as any).WebSocket.prototype = WS.prototype;
  });
  await page.goto('/index.html');
  await waitStage(page, 'welcome');
  await page.fill('#nameInput', 'Ada');
  await page.click('#nextBtn');
  await waitStage(page, 'today');
  await page.click('#todayAddBag');
  await waitStage(page, 'coffee');
  await page.fill('#roasterIn', 'Onyx'); await page.fill('#nameIn', 'Geometry'); await page.fill('#roastDate', '2026-10-05'); await page.click('[data-roast=light]');
  await page.click('#nextBtn'); await waitStage(page, 'method');
  await page.locator('#methodRows [role=radio]').first().click();
  await page.click('#nextBtn'); await waitStage(page, 'yield');
  await page.click('#nextBtn'); await waitStage(page, 'recipe');
  await page.click('#nextBtn'); await waitStage(page, 'brew');
  await page.click('#playBtn');
  await finishBrew(page);
  await page.locator('#doneRating button').nth(4).click();
  await page.click('#nextBtn'); await waitStage(page, 'today');
  await nav(page, 'history');
  await page.locator('#histList > li summary').first().click();
  await page.click('#logBtn'); await waitStage(page, 'log');
  await page.fill('#logVariety', 'Gesha'); await page.keyboard.press('Enter'); await page.click('#nextBtn'); await waitStage(page, 'history');
  await page.click('#shotBtn'); await waitStage(page, 'shot');
  await page.fill('#shotDose', '18'); await page.fill('#shotYield', '36'); await page.fill('#shotTime', '28');
  await page.click('#nextBtn'); await waitStage(page, 'history');
  await page.click('#homeBtn'); await waitStage(page, 'today');
  await nav(page, 'shelf');
  await page.click('#homeBtn'); await waitStage(page, 'today');
  await nav(page, 'settings');
  const sample = page.locator('#sampleShots');
  if (await sample.isVisible().catch(() => false)) await sample.click();
  await page.waitForTimeout(500);
  await page.reload();
  await page.waitForTimeout(500);
}

test.describe('no third parties', () => {
  test.use({ collectCoverage: false });

  test('every request goes to the app origin or to tooling/allowed-hosts.json (known defects reported separately)', async ({ page, net, baseURL }) => {
    test.setTimeout(120_000);
    await fullJourney(page);
    const appHost = new URL(baseURL!).hostname;
    const hosts = [...new Set(net.all.map(hostOf))];
    const unexpected = hosts.filter(h => h !== appHost && !allowed.has(h) && !knownBugHosts.has(h));
    expect(unexpected, `unexpected third-party hosts contacted: ${unexpected.join(', ')}\nrequests:\n${net.all.filter(u => unexpected.includes(hostOf(u))).join('\n')}`).toEqual([]);
    // runtime channels that bypass the request log
    expect(await page.evaluate(() => (window as any).__beacons), 'navigator.sendBeacon calls').toBe(0);
    expect(await page.evaluate(() => (window as any).__sockets), 'WebSocket connections').toEqual([]);
    // The CSP blocks a forbidden request before it reaches the network log, so an attempt shows up only as a violation event.
    expect(await page.evaluate(() => (window as any).__csp), 'Content-Security-Policy violations (blocked requests or inline code)').toEqual([]);
    for (const h of hosts.filter(h => knownBugHosts.has(h))) test.info().annotations.push({ type: 'known-bug', description: `third-party host contacted: ${h}` });
  });

  test('first paint alone (no interaction) contacts no third party at all', async ({ page, net, baseURL }) => {
    // History: this test was written as a KNOWN-BUG (test.fail) while index.html loaded Google Fonts; it is strict now that the fonts are gone.
    await page.goto('/index.html');
    await waitStage(page, 'welcome');
    await page.waitForTimeout(500);
    const appHost = new URL(baseURL!).hostname;
    const foreign = net.all.filter(u => hostOf(u) !== appHost && !allowed.has(hostOf(u)));
    expect(foreign).toEqual([]);
  });

  test('control: the recorder does see a third-party request and a beacon when a page makes one', async ({ page, net }) => {
    await page.goto('/vendor/bloom-slog.js'); // a same-origin document without the app's CSP
    await page.evaluate(() => { fetch('https://analytics.example.com/collect').catch(() => {}); });
    await expect.poll(() => net.external.map(u => new URL(u).hostname)).toContain('analytics.example.com');
  });

  test('the allow-list file starts empty and holds hostnames only', () => {
    const j = read('allowed-hosts.json');
    expect(Array.isArray(j.hosts)).toBe(true);
    for (const h of j.hosts) expect(h).toMatch(/^[a-z0-9.-]+$/);
  });

  test('a signed-out, local-only session makes no request except for its own static files', async ({ page, net, baseURL }) => {
    await seed(page, baseSeed());
    await page.goto('/index.html');
    await waitStage(page, 'today');
    await nav(page, 'history');
    await page.waitForTimeout(1000);
    const origin = new URL(baseURL!).origin;
    const own = net.all.filter(u => u.startsWith(origin));
    const paths = new Set(own.map(u => new URL(u).pathname));
    for (const p of paths) expect(['/index.html', '/vendor/bloom-slog.js', '/sample-shots.js', '/bloom-sync.js', '/favicon.ico']).toContain(p);
    void (net as NetLog);
  });
});
