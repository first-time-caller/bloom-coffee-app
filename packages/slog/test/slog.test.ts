import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseShot, parseIndex, shotToCurve, summarizeShot, slogPath, SlogError } from '../src/index.ts';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = (n: string) => new Uint8Array(readFileSync(join(dir, n)));
const ab = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

describe('parseShot current version', () => {
  const shot = parseShot(load('000123.slog'), 123);
  it('header', () => {
    expect(shot.id).toBe(123);
    expect(shot.version).toBe(8);
    expect(shot.startedAt).toBe('2025-10-09T08:53:20.000Z');
    expect(shot.profileName).toBe('Classic 9 Bar');
    expect(shot.profileId).toBe('classic-9bar');
    expect(shot.sampleIntervalMs).toBe(250);
    expect(shot.samples.length).toBe(120);
    expect(shot.durationMs).toBe(29750);
    expect(shot.brewDelayMs).toBe(1000);
    expect(shot.finalExitReason).toBe(1);
    expect(shot.finalWeightG).toBe(35.6);
  });
  it('phases with derived tMs', () => {
    expect(shot.phases.map(p => [p.phaseName, p.sampleIndex, p.tMs, p.reason])).toEqual([
      ['Pre-infusion', 0, 0, 0], ['Ramp', 24, 6000, 5], ['Extraction', 36, 9000, 5]]);
  });
  it('real units', () => {
    const s = shot.samples[40];
    expect(s.t).toBe(10000);
    expect(s.tt).toBe(93);
    expect(s.cp).toBeGreaterThan(8);
    expect(s.cp).toBeLessThan(9.5);
    expect(s.ct).toBeGreaterThan(92);
    expect(s.ct).toBeLessThan(94);
    expect(s.fl).toBeGreaterThan(1);
  });
  it('accepts ArrayBuffer and offset Uint8Array views', () => {
    const u = load('000123.slog');
    const padded = new Uint8Array(u.length + 7); padded.set(u, 7);
    expect(parseShot(ab(u)).samples.length).toBe(120);
    expect(parseShot(padded.subarray(7)).samples.length).toBe(120);
  });
});

describe('older versions', () => {
  for (const [file, ver, size] of [['000122.slog', 7, 30], ['000121.slog', 6, 28], ['000120.slog', 6, 26], ['000119.slog', 5, 26], ['000118.slog', 4, 26]] as const) {
    it(`v${ver} (${size}-byte records) ${file}`, () => {
      const s = parseShot(load(file));
      expect(s.version).toBe(ver);
      expect(s.samples.length).toBe(120);
      expect(s.samples[119].t).toBe(29750);
      expect(s.durationMs).toBe(29750);
      expect(s.samples[40].cp).toBeCloseTo(parseShot(load('000123.slog')).samples[40].cp!, 5);
      expect(s.phases.length).toBe(ver >= 5 ? 3 : 0);
      if (ver < 8) expect(s.samples[0].wp === undefined || ver === 7 || s.samples[0].wp === 0).toBe(true);
    });
  }
});

describe('fieldsMask', () => {
  const s = parseShot(load('000124.slog'));
  it('omits absent fields', () => {
    for (const k of ['v', 'ev', 'vf', 'wp'] as const) expect(k in s.samples[10]).toBe(false);
    expect(s.samples[10].cp).toBeDefined();
    expect(s.finalWeightG).toBeNull();
  });
  it('curve has null weight, real pressure', () => {
    const c = shotToCurve(s);
    expect(c.w.every(x => x === null)).toBe(true);
    expect(c.p.every(x => x !== null)).toBe(true);
  });
  it('summary yield null', () => expect(summarizeShot(s).yieldG).toBeNull());
});

describe('unpatched header (still recording)', () => {
  it('infers sample count and duration', () => {
    const s = parseShot(load('000125.slog'));
    expect(s.samples.length).toBe(40);
    expect(s.durationMs).toBe(9750);
  });
});

describe('errors', () => {
  const good = load('000123.slog');
  const code = (f: () => unknown) => { try { f(); } catch (e) { expect(e).toBeInstanceOf(SlogError); return (e as SlogError).code; } return 'NONE'; };
  it('bad magic', () => {
    const b = good.slice(); b[0] = 0;
    expect(code(() => parseShot(b))).toBe('BAD_MAGIC');
  });
  it('tiny / empty', () => {
    expect(code(() => parseShot(new Uint8Array(0)))).toBe('TRUNCATED');
    expect(code(() => parseShot(good.subarray(0, 100)))).toBe('TRUNCATED');
  });
  it('truncated samples', () => {
    expect(code(() => parseShot(good.subarray(0, good.length - 31)))).toBe('TRUNCATED');
    const p = parseShot(good.subarray(0, good.length - 31), 1, { allowPartial: true });
    expect(p.samples.length).toBe(118);
    expect(p.durationMs).toBe(p.samples[117].t);
  });
  it('header size / sample size mismatch', () => {
    const b = good.slice(); new DataView(b.buffer).setUint16(6, 128, true);
    expect(code(() => parseShot(b))).toBe('CORRUPT');
    const c = good.slice(); c[5] = 26;
    expect(code(() => parseShot(c))).toBe('CORRUPT');
  });
  it('never throws a non-SlogError on random truncation / flips', () => {
    let seed = 1; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 500; i++) {
      const b = good.slice(0, Math.floor(rnd() * good.length));
      if (b.length && rnd() < 0.5) b[Math.floor(rnd() * Math.min(b.length, 600))] ^= 1 << Math.floor(rnd() * 8);
      try { parseShot(b); } catch (e) { expect(e).toBeInstanceOf(SlogError); }
    }
  });
});

describe('parseIndex', () => {
  const rows = parseIndex(load('index.bin'));
  it('entries', () => {
    expect(rows.length).toBe(3);
    expect(rows[0]).toEqual({ id: 123, startedAt: '2025-10-09T08:53:20.000Z', durationMs: 29750, profileName: 'Classic 9 Bar', finalWeightG: 36, rating: 4, volumeG: 36, deleted: false });
    expect(rows[1].deleted).toBe(true);
    expect(rows[2].finalWeightG).toBeNull();
    expect(rows[2].profileName).toBe('Café Lungo');
  });
  it('recent.bin shares layout', () => expect(parseIndex(load('recent.bin')).map(r => r.id)).toEqual([123, 122]));
  it('errors', () => {
    const b = load('index.bin');
    expect(() => parseIndex(b.subarray(0, 100))).toThrow(SlogError);
    expect(() => parseIndex(load('000123.slog'))).toThrow(/magic/);
    expect(() => parseIndex(new Uint8Array(4))).toThrow(SlogError);
  });
});

describe('curve / summary / path', () => {
  const shot = parseShot(load('000123.slog'), 123);
  it('curve grid', () => {
    const c = shotToCurve(shot);
    expect(c.stepMs).toBe(500);
    expect(c.p.length).toBe(60);
    for (const a of [c.p, c.f, c.w, c.c]) expect(a.length).toBe(60);
    expect(c.w[0]).toBe(0);
    expect(c.w[59]).toBeGreaterThan(34);
    expect(c.c[10]).toBeGreaterThan(92);
    // one decimal
    for (const x of c.p) expect(Math.abs(x! * 10 - Math.round(x! * 10))).toBeLessThan(1e-9);
    expect(shotToCurve(shot, 1000).p.length).toBe(30);
  });
  it('interpolates linearly', () => {
    const fake = { ...shot, durationMs: 1000, samples: [{ t: 0, cp: 0 }, { t: 1000, cp: 10 }] };
    expect(shotToCurve(fake, 250).p).toEqual([0, 2.5, 5, 7.5, 10]);
  });
  it('summary', () => {
    const s = summarizeShot(shot);
    expect(s.timeS).toBe(29.8);
    expect(s.yieldG).toBe(35.6);
    expect(s.peakPressureBar).toBe(9);
    expect(s.avgTempC).toBeGreaterThan(92); expect(s.avgTempC).toBeLessThan(94);
  });
  it('slogPath', () => {
    expect(slogPath(123)).toBe('/api/history/000123.slog');
    expect(slogPath(1234567)).toBe('/api/history/1234567.slog');
  });
});

// Oracle: upstream JS parsers (read from the reference clone, test-only).
const ORACLE = '/tmp/claude-0/ref/gaggimate/web/src/pages/ShotHistory';
describe.skipIf(!existsSync(join(ORACLE, 'parseBinaryShot.js')))('upstream oracle', () => {
  it('matches upstream parseBinaryShot on every fixture', async () => {
    const up = await import(/* @vite-ignore */ pathToFileURL(join(ORACLE, 'parseBinaryShot.js')).href);
    for (const f of readdirSync(dir).filter(n => n.endsWith('.slog'))) {
      const u = load(f);
      const mine = parseShot(u, 1);
      const theirs = up.parseBinaryShot(ab(u), 1);
      expect(mine.samples.length, f).toBe(theirs.samples.length);
      expect(mine.durationMs, f).toBe(theirs.duration);
      expect(mine.version, f).toBe(theirs.version);
      expect(Math.floor(Date.parse(mine.startedAt) / 1000), f).toBe(theirs.timestamp);
      expect(mine.finalWeightG, f).toBe(theirs.volume);
      expect(mine.brewDelayMs, f).toBe(theirs.brewDelay);
      expect(mine.phases.map(p => [p.sampleIndex, p.phaseNumber, p.phaseName, p.reason]), f)
        .toEqual(theirs.phaseTransitions.map((p: any) => [p.sampleIndex, p.phaseNumber, p.phaseName, p.transitionReason]));
      mine.samples.forEach((s, i) => {
        const o = theirs.samples[i];
        expect(s.t).toBe(o.t);
        for (const k of ['tt', 'ct', 'tp', 'cp', 'fl', 'tf', 'pf', 'vf', 'v', 'ev', 'pr', 'wp'] as const) {
          if (o[k] === undefined) expect(k in s, `${f} ${k}`).toBe(false);
          else expect(s[k], `${f} ${i} ${k}`).toBeCloseTo(o[k], 9);
        }
        if (o.systemInfo) expect(s.si).toBe(o.systemInfo.raw);
      });
    }
  });
  it('matches upstream parseBinaryIndex', async () => {
    const up = await import(/* @vite-ignore */ pathToFileURL(join(ORACLE, 'parseBinaryIndex.js')).href);
    const theirs = up.parseBinaryIndex(ab(load('index.bin'))).entries;
    const mine = parseIndex(load('index.bin'));
    expect(mine.length).toBe(theirs.length);
    mine.forEach((m, i) => {
      const t = theirs[i];
      expect([m.id, Date.parse(m.startedAt) / 1000, m.durationMs, m.finalWeightG, m.rating, m.profileName, m.deleted])
        .toEqual([t.id, t.timestamp, t.duration, t.volume, t.rating, t.profileName, t.deleted]);
    });
  });
});
