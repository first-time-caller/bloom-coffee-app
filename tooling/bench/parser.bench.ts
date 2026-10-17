/**
 * Speed gate: parser macro-benchmarks. scripts/bench-check.mjs compares each result to bench/baseline.json AFTER normalising
 * by the "calibration" benchmark, so a slower or noisier CI machine does not cause false failures.
 */
import { bench, describe } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseShot, parseIndex, shotToCurve } from '../../packages/slog/src/index.ts';

const fx = join(import.meta.dirname, '../../packages/slog/test/fixtures');
const shot = new Uint8Array(readFileSync(join(fx, '000123.slog')));
const index = new Uint8Array(readFileSync(join(fx, 'index.bin')));
const parsed = parseShot(shot, 123);

// Fixed pure-JS workload of similar flavour (typed-array reads + float math). Its speed tracks the machine, not our code.
const calib = new Float64Array(4096).map((_, i) => Math.sin(i));
function calibrate() {
  let s = 0;
  for (let r = 0; r < 20; r++) for (let i = 0; i < calib.length; i++) s += calib[i] * 1.0001 + (i & 7);
  return s;
}

describe('parser', () => {
  bench('calibration', () => { calibrate(); }, { time: 800 });
  bench('parseShot', () => { parseShot(shot, 123); }, { time: 800 });
  bench('parseIndex', () => { parseIndex(index); }, { time: 800 });
  bench('shotToCurve', () => { shotToCurve(parsed, 500); }, { time: 800 });
});
