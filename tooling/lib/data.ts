/** Deterministic seed data in the exact shapes the app persists (see cleanRecord/cleanBag/espressoRecord in web/index.html). */

export const FIXED_NOW = '2026-10-17T08:00:00.000Z';

export type Seed = {
  name?: string | null;
  pro?: boolean;
  bags?: any[];
  history?: any[];
  extra?: Record<string, unknown>; // raw extra localStorage values (will be JSON-stringified)
};

const iso = (daysAgo: number, h = 8) => new Date(Date.parse(FIXED_NOW) - daysAgo * 864e5 + (h - 8) * 36e5).toISOString();
const day = (daysAgo: number) => iso(daysAgo).slice(0, 10);

export function bag(over: Record<string, unknown> = {}) {
  return {
    id: 'bag-fixture-1', createdAt: iso(14), status: 'open', order: -1, roaster: 'Onyx', name: 'Geometry', varieties: [], components: [], process: '', grade: '',
    altitude: '', decaf: false, labelNotes: '', notes: [], roast: 'light', roastInferred: false, roastDate: day(12), roastDateText: '', restDays: '', useWithinDays: '',
    restUntil: '', openedOn: '', frozenOn: '', thawedOn: '', weightG: '', source: '', roasterRecipe: '', updatedAt: iso(14), schema: 1,
    origin: { v: 1, source: 'none', where: '', harvest: [] }, ...over
  };
}

export function brewRecord(i: number, over: Record<string, unknown> = {}) {
  const methods = ['v60', 'kalita', 'chemex', 'aeropress'];
  return {
    id: `rec-brew-${i}`, createdAt: iso(i * 0.5 + 0.2), variety: '', varieties: [], roaster: 'Onyx', name: `Geometry ${i}`, labelNotes: '', components: [], process: '', grade: '',
    altitude: '', decaf: false, weightG: null, restDays: null, useWithinDays: null, roastDateText: '', roastDate: day(12 + i), roast: 'light', boughtFrom: '',
    pourPlan: [45, 96, 73, 72], bloomSec: 40, tasted: [], tastedText: '', coolNote: '', buyAgain: '', grinderId: '', grinderName: '', grindUnit: '', grindSetting: '',
    waterId: '', waterName: '', waterGH: null, waterKH: null, notes: [], method: methods[i % methods.length], yieldMl: 250, dose: 17.9, water: 286, temp: 95, cup: 250,
    totalSec: 155, source: 'timer', rating: i % 6, note: i % 5 === 0 ? 'Bright and juicy.' : '', taste: '', drainSec: 130, pourTimes: [15, 41, 70, 100, 130], iced: false,
    recipeName: 'Bloom', custom: null, technique: null, roasterRecipe: '', openedOn: '', frozenOn: '', thawedOn: '', restUntil: '', daysOff: 12, frozenDays: 0, bagId: 'bag-fixture-1', schema: 1,
    ...over
  };
}

/** A 30 s shot sampled every 500 ms (61 points), matching EspressoCurve { stepMs, p, f, w, c }. */
export function curve(n = 61) {
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const arr = (fn: (t: number) => number) => Array.from({ length: n }, (_, k) => r1(fn(k * 0.5)));
  return {
    stepMs: 500,
    p: arr(t => (t < 6 ? t * 1.4 : 9 - (t - 6) * 0.05)),
    f: arr(t => (t < 6 ? 0.2 : 1.8 + Math.sin(t) * 0.2)),
    w: arr(t => Math.max(0, (t - 8) * 1.5)),
    c: arr(() => 93)
  };
}

export function espressoRecord(i: number, over: Record<string, unknown> = {}) {
  const dose = 18, yld = 36 + (i % 5);
  return {
    id: `rec-esp-${i}`, createdAt: iso(i * 0.5 + 0.1), source: 'log', kind: 'espresso', method: 'Espresso', doseG: dose, yieldG: yld, timeS: 26 + (i % 6), ratio: Math.round((yld / dose) * 100) / 100,
    grind: '12', grinderId: '', grinderName: '', grindUnit: '', grindSetting: '12', profile: 'Classic 9 bar', peakPressureBar: 9.1, avgTempC: 93, rating: (i + 2) % 6, taste: '', note: '',
    bagId: 'bag-fixture-1', variety: '', varieties: [], roaster: 'Onyx', name: 'Geometry', roast: 'light', roastDate: day(12), process: '', components: [], curve: curve(),
    machine: { machineId: 'gm-fixture', shotId: 100 + i, profileName: 'Classic 9 bar' }, schema: 1, ...over
  };
}

/** Mixed history, newest first, as the app stores it. */
export function history(n: number, espressoEvery = 3) {
  return Array.from({ length: n }, (_, i) => (i % espressoEvery === 0 ? espressoRecord(i) : brewRecord(i)));
}

export const baseSeed = (over: Partial<Seed> = {}): Seed => ({ name: 'Ada', pro: true, bags: [bag()], history: history(6), ...over });
