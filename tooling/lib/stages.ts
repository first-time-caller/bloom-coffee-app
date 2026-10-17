import type { Page } from '@playwright/test';
import { expect, finishBrew, nav, waitStage } from './test';

/**
 * Every screen a user can reach, with a function that navigates to it from a freshly loaded, seeded app (history of 6 mixed
 * records, one open bag, Pro mode so every field is rendered). Order matters: each step starts where the previous one ended
 * unless it says otherwise. `welcome` is reached by the rename button.
 */
export type StageStep = { id: string; stage: string; go: (page: Page) => Promise<void> };

const settle = (page: Page) => page.waitForTimeout(700); // stage transitions are 450-600 ms; scan only when they are over

export const STAGE_STEPS: StageStep[] = [
  { id: 'today', stage: 'today', go: async p => { await waitStage(p, 'today'); await settle(p); } },
  { id: 'shelf', stage: 'shelf', go: async p => { await nav(p, 'shelf'); await settle(p); } },
  { id: 'settings', stage: 'settings', go: async p => { await nav(p, 'settings'); await settle(p); } },
  {
    id: 'history-expanded', stage: 'history',
    go: async p => {
      await p.click('#homeBtn'); await waitStage(p, 'today');
      await nav(p, 'history');
      await p.locator('#histList > li summary').first().click();
      await expect(p.locator('#histList > li details[open]')).toHaveCount(1);
      await settle(p);
    }
  },
  { id: 'history-espresso-expanded', stage: 'history', go: async p => {
      await p.locator('#histList > li:has(.h-kind) summary').first().click();
      await settle(p);
  } },
  { id: 'log', stage: 'log', go: async p => { await p.click('#logBtn'); await waitStage(p, 'log'); await settle(p); } },
  { id: 'shot', stage: 'shot', go: async p => { await p.click('#homeBtn'); await waitStage(p, 'today'); await nav(p, 'history'); await p.click('#shotBtn'); await waitStage(p, 'shot'); await settle(p); } },
  {
    id: 'coffee', stage: 'coffee',
    go: async p => { await p.click('#homeBtn'); await waitStage(p, 'today'); await p.click('#todayNewBag'); await waitStage(p, 'coffee'); await settle(p); }
  },
  {
    id: 'method', stage: 'method',
    go: async p => {
      await p.fill('#roasterIn', 'Onyx'); await p.fill('#nameIn', 'Geometry'); await p.fill('#roastDate', '2026-10-05'); await p.click('[data-roast=light]');
      await p.click('#nextBtn'); await waitStage(p, 'method'); await settle(p);
    }
  },
  { id: 'yield', stage: 'yield', go: async p => { await p.locator('#methodRows [role=radio]').first().click(); await p.click('#nextBtn'); await waitStage(p, 'yield'); await settle(p); } },
  { id: 'recipe', stage: 'recipe', go: async p => { await p.click('#nextBtn'); await waitStage(p, 'recipe'); await settle(p); } },
  { id: 'brew', stage: 'brew', go: async p => { await p.click('#nextBtn'); await waitStage(p, 'brew'); await settle(p); } },
  {
    id: 'brew-running', stage: 'brew',
    go: async p => { await p.click('#playBtn'); await expect(p.locator('#pauseBtn')).toBeVisible(); await settle(p); }
  }
,
  { id: 'done', stage: 'done', go: async p => { await finishBrew(p); await settle(p); } }
];
