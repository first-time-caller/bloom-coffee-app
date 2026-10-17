/**
 * Gate: Accessibility. axe (WCAG 2.2 AA) on every reachable stage in light, dark and forced-colors; large-text reflow at 200%; keyboard order.
 * Zero violations allowed. Anything in a KNOWN_* list is a reported KNOWN-BUG (see lib/known.ts) and must be removed once fixed.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect, seed, waitStage, nav } from '../lib/test';
import { baseSeed, FIXED_NOW } from '../lib/data';
import { expectOnlyKnown, type Known } from '../lib/known';
import { STAGE_STEPS } from '../lib/stages';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
// Findings are strings like "[stage] rule-id target". Each KNOWN entry must still reproduce (in every colour mode), or the test fails.
const KNOWN_AXE: Known[] = [
  { pattern: /^\[(history-expanded|history-espresso-expanded)\] aria-allowed-attr #histKind /, reason: 'KNOWN-BUG: the History filter chips (#histKind) are role="radio" but also carry aria-pressed, which radios do not allow. Use aria-checked only.' },
  { pattern: /^\[shot\] aria-allowed-attr #(shotBags|shotAim) /, reason: 'KNOWN-BUG: Log-a-shot chips (#shotBags, #shotAim) are role="radio" with aria-pressed. Use aria-checked only.' },
  { pattern: /^\[done\] aria-allowed-attr button\[data-v=/, reason: 'KNOWN-BUG: the "Would you buy it again?" chips on the Done screen are role="radio" with aria-pressed. Use aria-checked only.' },
  { pattern: /^\[settings\] target-size #brChips /, reason: 'KNOWN-BUG (WCAG 2.5.8): wrapped chips in Settings > brewers (#brChips) overlap their neighbours; the target is partly obscured and under 24x24 CSS px of free space.' },
  { pattern: /^\[done\] target-size #tastedChips /, reason: 'KNOWN-BUG (WCAG 2.5.8, intermittent): wrapped flavour chips on the Done screen (#tastedChips) are partly obscured and under 24x24 CSS px of free space when a row wraps.', optional: true }
];

async function scan(page: Page, opts: { forcedColors?: boolean } = {}) {
  let b = new AxeBuilder({ page }).withTags(TAGS);
  // Chromium's forcedColors emulation flips the media query but does not recolour computed styles, so axe's contrast maths would be
  // meaningless there. Real forced-colors rendering is the OS palette, whose contrast the UA guarantees. Everything else still runs.
  if (opts.forcedColors) b = b.disableRules(['color-contrast']);
  const r = await b.analyze();
  return r.violations.flatMap(v => v.nodes.map(n => ({ id: v.id, impact: v.impact, help: v.help, target: n.target.join(' '), why: (n.failureSummary || '').split('\n').slice(0, 3).join(' | ') })));
}

const MODES = [
  { name: 'light', media: { colorScheme: 'light' as const } },
  { name: 'dark', media: { colorScheme: 'dark' as const } },
  { name: 'forced-colors', media: { colorScheme: 'light' as const, forcedColors: 'active' as const } }
];

test.describe('axe: every stage', () => {
  test.use({ collectCoverage: false });
  for (const mode of MODES) {
    test(`all stages, ${mode.name}`, async ({ page }) => {
      test.setTimeout(150_000);
      await page.clock.install({ time: new Date(FIXED_NOW) });
      await page.emulateMedia(mode.media);
      await seed(page, baseSeed());
      await page.goto('/index.html');
      const findings: string[] = [];
      for (const step of STAGE_STEPS) {
        await test.step(step.id, async () => {
          await step.go(page);
          expect(await page.evaluate(() => (document.querySelector('.stage[data-pos="active"]') as HTMLElement).dataset.stage)).toBe(step.stage);
          for (const v of await scan(page, { forcedColors: !!(mode.media as any).forcedColors })) findings.push(`[${step.id}] ${v.id} ${v.target} (${v.impact}: ${v.help}) ${v.why}`);
        });
      }
      expectOnlyKnown(findings, KNOWN_AXE, `axe ${mode.name}`);
    });
  }

  for (const mode of MODES) {
    test(`welcome, ${mode.name}`, async ({ page }) => {
      await page.emulateMedia(mode.media);
      await page.goto('/index.html'); // no seed: first run
      await waitStage(page, 'welcome');
      await page.waitForTimeout(700);
      const v = await scan(page, { forcedColors: !!(mode.media as any).forcedColors });
      expect(v.map(x => `[welcome] ${x.id} ${x.target} ${x.why}`)).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// Large text: simulate OS font scaling (Dynamic Type / Android font size) at 375 px wide.
// The app sizes text in px, so root font-size alone would change nothing; we also double every computed font-size.
// ---------------------------------------------------------------------------------------------------------------------------
async function scaleText(page: Page, factor: number) {
  await page.evaluate(f => {
    document.documentElement.style.fontSize = `${f * 100}%`;
    const els = Array.from(document.querySelectorAll<HTMLElement>('body *'));
    const sizes = els.map(e => parseFloat(getComputedStyle(e).fontSize));
    els.forEach((e, i) => { if (!e.dataset.scaled) { e.dataset.scaled = '1'; e.style.setProperty('font-size', `${sizes[i] * f}px`, 'important'); } });
  }, factor);
}

type Box = { sel: string; text: string; x: number; y: number; w: number; h: number; clippedX: boolean; tag: string };
async function boxes(page: Page): Promise<{ overflow: number; boxes: Box[] }> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const root = document.documentElement;
    const scope = [document.querySelector('.stage[data-pos="active"]'), document.querySelector('header.top'), document.querySelector('#actions')].filter(Boolean) as Element[];
    const sel = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=radio], [role=checkbox]';
    const out: any[] = [];
    for (const sc of scope) for (const el of Array.from(sc.querySelectorAll<HTMLElement>(sel))) {
      const cs = getComputedStyle(el), r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || cs.display === 'none' || el.closest('[hidden], [inert]')) continue;
      if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'range') { /* slider: keep */ }
      const id = el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(/\s+/).filter(Boolean).slice(0, 2).join('.') : ''}`;
      out.push({ sel: id, text: (el.getAttribute('aria-label') || el.textContent || (el as HTMLInputElement).placeholder || '').trim().slice(0, 30), x: r.left, y: r.top, w: r.width, h: r.height, clippedX: r.left < -0.5 || r.right > vw + 0.5, tag: el.tagName });
    }
    return { overflow: root.scrollWidth - vw, boxes: out };
  });
}

test.describe('large text (200%) at 375 px', () => {
  test.use({ viewport: { width: 375, height: 800 }, collectCoverage: false });
  const KNOWN_LARGE: Known[] = [
    { pattern: /#(shelf|history|settings)Btn ".*" is clipped by the viewport/, reason: 'KNOWN-BUG: the header nav (.top-actions: Shelf / History / Settings) does not wrap or shrink at 200% text, so History and Settings are pushed off the right edge of a 375 px screen.' },
    { pattern: /horizontal overflow: page is \d+px wider/, reason: 'KNOWN-BUG: whole-page horizontal scroll at 200% text on every screen, caused by the header nav (and on Yield by the stepper buttons). Fix the header first, then delete this entry to see what is left.' },
    { pattern: /#shotBtn "Log a shot" is clipped/, reason: 'KNOWN-BUG: the "Log a coffee / Log a shot" row on History overflows at 200% text.' },
    { pattern: /#yield(Minus|Plus) ".*" is clipped by the viewport/, reason: 'KNOWN-BUG: the +/- steppers on the Yield screen are pushed off-screen by the 200% headline number.' },
    { pattern: /#td(Minus|Plus) ".*" hit target \d+x\d+ < 44x44/, reason: 'KNOWN-BUG: the dose +/- buttons on Today shrink to 31 px wide at 200% text.' },
    { pattern: /button\.rb-x ".*" hit target \d+x\d+ < 44x44/, reason: 'KNOWN-BUG: the remove-pour (x) buttons in the recipe editor are 40x40.' }
  ];

  test('no horizontal overflow, no clipped controls, 44x44 hit targets on every stage', async ({ page }) => {
    test.setTimeout(150_000);
    await page.clock.install({ time: new Date(FIXED_NOW) });
    await seed(page, baseSeed());
    await page.goto('/index.html');
    const problems: string[] = [];
    for (const step of STAGE_STEPS) {
      if (step.id === 'history-espresso-expanded') continue;
      await step.go(page);
      await scaleText(page, 2);
      await page.waitForTimeout(150);
      const { overflow, boxes: bs } = await boxes(page);
      if (overflow > 1) problems.push(`[${step.id}] horizontal overflow: page is ${overflow}px wider than the viewport`);
      for (const b of bs) {
        if (b.clippedX) problems.push(`[${step.id}] ${b.sel} "${b.text}" is clipped by the viewport (x ${Math.round(b.x)}..${Math.round(b.x + b.w)})`);
        const small = (b.w < 44 || b.h < 44) && b.tag !== 'INPUT' && b.tag !== 'SELECT' && b.tag !== 'TEXTAREA'; // form fields are wide; only buttons/links/summaries are judged
        if (small) problems.push(`[${step.id}] ${b.sel} "${b.text}" hit target ${Math.round(b.w)}x${Math.round(b.h)} < 44x44`);
      }
    }
    expectOnlyKnown(problems, KNOWN_LARGE, 'large text');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Keyboard: tab through the main screens; every stop has a visible focus ring, is on screen, and the order follows the layout.
// ---------------------------------------------------------------------------------------------------------------------------
type Stop = { desc: string; top: number; left: number; w: number; h: number; ring: boolean; inScope: boolean };
async function tabStops(page: Page, max = 80): Promise<Stop[]> {
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
  const stops: Stop[] = [];
  let first = '';
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const s = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== 'none') || el.matches('summary') && cs.outlineStyle !== 'none';
      const scope = [document.querySelector('.stage[data-pos="active"]'), document.querySelector('header.top'), document.querySelector('#actions')].some(s => !!s && s.contains(el));
      const id = el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(/\s+/).filter(Boolean)[0] : ''}`;
      return { desc: `${id} "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24)}"`, top: r.top + window.scrollY, left: r.left, w: r.width, h: r.height, ring: !!ring, inScope: scope };
    });
    if (!s) break; // focus left the document (browser chrome): one full cycle done
    if (!first) first = s.desc; else if (s.desc === first) break;
    stops.push(s);
  }
  return stops;
}

const KNOWN_KEYS: Known[] = [
  { pattern: /^\[shot\] no visible focus indicator on #shotNote/, reason: 'KNOWN-BUG: the notes textarea on Log a shot (.note-in) removes the focus outline and draws no replacement, so keyboard users cannot see where they are. Add a :focus-visible style.' }
];

test.describe('keyboard', () => {
  test.use({ collectCoverage: false });
  const SCREENS: { id: string; stage: string; go: (p: Page) => Promise<void> }[] = [
    { id: 'today', stage: 'today', go: async p => { await waitStage(p, 'today'); } },
    { id: 'recipe', stage: 'recipe', go: async p => { await p.click('#todayAdjust'); await waitStage(p, 'recipe'); } },
    { id: 'history', stage: 'history', go: async p => { await p.click('#homeBtn'); await waitStage(p, 'today'); await nav(p, 'history'); } },
    { id: 'shot', stage: 'shot', go: async p => { await p.click('#shotBtn'); await waitStage(p, 'shot'); } },
    { id: 'settings', stage: 'settings', go: async p => { await p.click('#homeBtn'); await waitStage(p, 'today'); await nav(p, 'settings'); } }
  ];

  test('visible focus, on-screen stops and layout-ordered Tab sequence on the key screens', async ({ page }) => {
    test.setTimeout(120_000);
    await page.clock.install({ time: new Date(FIXED_NOW) });
    await seed(page, baseSeed());
    await page.goto('/index.html');
    const problems: string[] = [];
    for (const sc of SCREENS) {
      await sc.go(page);
      await page.waitForTimeout(700);
      const stops = await tabStops(page);
      if (stops.length < 3) problems.push(`[${sc.id}] only ${stops.length} focusable stops`);
      let prev: Stop | null = null;
      for (const s of stops) {
        if (!s.ring) problems.push(`[${sc.id}] no visible focus indicator on ${s.desc}`);
        if (!s.inScope) problems.push(`[${sc.id}] focus landed outside the active screen: ${s.desc}`);
        if (s.w === 0 || s.h === 0) problems.push(`[${sc.id}] focus on a zero-size element: ${s.desc}`);
        // logical order: never jump up the page by more than a row's slop (the footer actions bar is fixed below the content)
        if (prev && s.top < prev.top - 24) problems.push(`[${sc.id}] focus order jumps backwards: ${prev.desc} (y ${Math.round(prev.top)}) -> ${s.desc} (y ${Math.round(s.top)})`);
        prev = s;
      }
      // the screen's own heading takes focus on entry (go() focuses h1), so the first Tab goes to the first control after it or the header
    }
    expectOnlyKnown(problems, KNOWN_KEYS, 'keyboard');
  });

  test('Enter and Space operate the primary buttons and radios from the keyboard', async ({ page }) => {
    await seed(page, baseSeed());
    await page.goto('/index.html');
    await waitStage(page, 'today');
    await page.locator('#todayAdjust').focus();
    await page.keyboard.press('Enter');
    await waitStage(page, 'recipe');
    await page.locator('#nextBtn').focus();
    await page.keyboard.press('Space');
    await waitStage(page, 'brew');
    await page.locator('#backBtn').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter'); // tap again to cancel; returns to the recipe it came from
    await waitStage(page, 'recipe');
    await page.locator('#backBtn').focus();
    await page.keyboard.press('Enter'); // Today
    await waitStage(page, 'today');
    await nav(page, 'settings');
    const radio = page.locator('#modeSeg [role=radio]').first();
    await radio.focus();
    await page.keyboard.press('Space');
    await expect(radio).toHaveAttribute('aria-checked', 'true');
  });
});
