/** Edge-case tests added with the reliability gate to cover error and degenerate-input branches. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseShot, parseIndex, shotToCurve, summarizeShot, slogPath, SlogError } from '../src/index.ts';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = (n: string) => new Uint8Array(readFileSync(join(dir, n)));
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as SlogError).code; } return 'NO_THROW'; };

describe('input validation', () => {
  it('rejects non-buffer input', () => {
    expect(code(() => parseShot('nope' as any))).toBe('CORRUPT');
    expect(code(() => parseIndex(42 as any))).toBe('CORRUPT');
  });
  it('rejects a too-small index and a bad magic', () => {
    expect(code(() => parseIndex(new Uint8Array(4)))).toBe('TRUNCATED');
    expect(code(() => parseIndex(new Uint8Array(64)))).toBe('BAD_MAGIC');
  });
  it('rejects an unsupported index entry size', () => {
    const idx = load('index.bin').slice();
    new DataView(idx.buffer).setUint16(6, 999, true);
    expect(code(() => parseIndex(idx))).toBe('UNSUPPORTED');
  });
  it('rejects a truncated index', () => {
    const idx = load('index.bin').slice();
    expect(code(() => parseIndex(idx.subarray(0, idx.length - 10)))).toBe('TRUNCATED');
  });
});

describe('degenerate shots', () => {
  const shot = parseShot(load('000123.slog'), 123);
  it('shotToCurve rejects a non-positive step', () => {
    expect(code(() => shotToCurve(shot, 0))).toBe('CORRUPT');
    expect(code(() => shotToCurve(shot, -5))).toBe('CORRUPT');
  });
  it('shotToCurve handles zero samples and one sample', () => {
    const none = shotToCurve({ ...shot, samples: [], durationMs: 0 });
    expect(none.p).toEqual([]);
    const one = shotToCurve({ ...shot, samples: [shot.samples[0]], durationMs: 0 });
    expect(one.p.length).toBe(1);
  });
  it('shotToCurve yields nulls for never-recorded series', () => {
    const bare = { ...shot, samples: shot.samples.map(s => ({ t: s.t })) } as any;
    const c = shotToCurve(bare);
    expect(c.p.every(v => v === null)).toBe(true);
  });
  it('summarizeShot copes with no samples', () => {
    const s = summarizeShot({ ...shot, samples: [], durationMs: 0 });
    expect(s.peakPressureBar).toBeNull();
    expect(s.avgTempC).toBeNull();
  });
  it('slogPath pads and truncates', () => {
    expect(slogPath(7.9)).toBe('/api/history/000007.slog');
  });
});
