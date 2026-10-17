// Generates synthetic .slog / index.bin fixtures byte-for-byte per shot_log_format.h.
// Run: node test/make-fixtures.ts   (Node >= 22.18, or `npm run fixtures`)
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseShot } from '../src/index.ts';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
mkdirSync(dir, { recursive: true });

// Scaled-int sample as the firmware stores it.
interface Raw { t: number; tt: number; ct: number; tp: number; cp: number; fl: number; tf: number; pf: number; vf: number; v: number; ev: number; pr: number; si: number; wp: number }
const ORDER = ['tt', 'ct', 'tp', 'cp', 'fl', 'tf', 'pf', 'vf', 'v', 'ev', 'pr', 'si', 'wp'] as const;
const SIGNED = new Set(['fl', 'tf', 'pf', 'vf']);

export interface Spec {
  version: number;
  /** record size byte (reserved0); null = compute from mask */
  reserved0?: number;
  mask: number;
  startEpoch: number;
  profileId: string;
  profileName: string;
  phases: { sampleIndex: number; name: string; reason: number }[];
  finalExitReason: number;
  brewDelayMs: number;
  /** true: write header sampleCount/duration as 0 (shot still recording) */
  unpatched?: boolean;
  samples: Raw[];
  interval?: number;
}

export function synthSamples(seconds = 30, withScale = true): Raw[] {
  const out: Raw[] = [];
  const n = Math.round(seconds / 0.25);
  let pumped = 0;
  for (let i = 0; i < n; i++) {
    const t = i * 250, s = t / 1000;
    // preinfusion ramp to ~2 bar (0-6 s), ramp to 9 bar (6-9 s), hold 9 bar to end
    const pTarget = s < 6 ? 2 : 9;
    const cp = s < 6 ? 2 * (1 - Math.exp(-s / 1.2)) : s < 9 ? 2 + (7 * (s - 6)) / 3 : 9 - 0.4 * Math.min(1, (s - 9) / 20);
    const flow = s < 2 ? 3 * (s / 2) : s < 6 ? 0.4 : s < 9 ? 0.4 + (1.6 * (s - 6)) / 3 : 2.0 - 0.3 * Math.min(1, (s - 9) / 20);
    pumped += flow * 0.25;
    const weight = s < 9 ? 0 : (36 * (s - 9)) / (seconds - 9);
    out.push({
      t,
      tt: 930, ct: Math.round((92.4 + 0.7 * Math.min(1, s / 8) + 0.15 * Math.sin(s)) * 10),
      tp: pTarget * 10, cp: Math.round(cp * 10),
      fl: Math.round(flow * 100), tf: s < 6 ? 0 : 200, pf: Math.round(flow * 100 * 0.95), vf: withScale ? Math.round((s < 9 ? 0 : 1.8) * 100) : 0,
      v: withScale ? Math.round(weight * 10) : 0, ev: Math.round(weight * 10),
      pr: Math.round(800 / Math.max(flow, 0.3)), si: 0x0129, wp: Math.round(pumped * 10),
    });
  }
  return out;
}

export function encodeShot(sp: Spec): Uint8Array {
  const hdrSize = sp.version <= 4 ? 128 : 512;
  const elapsed = sp.version >= 6 && !(sp.version === 6 && sp.reserved0 === 26 && sp.mask === 0x1fff);
  const hasT = (sp.mask & 1) !== 0;
  const fields = ORDER.filter((_, i) => sp.mask & (1 << (i + 1)));
  const rec = fields.length * 2 + (hasT ? (elapsed ? 4 : 2) : 0);
  const buf = new Uint8Array(hdrSize + rec * sp.samples.length);
  const dv = new DataView(buf.buffer);
  const enc = new TextEncoder();
  dv.setUint32(0, 0x544f4853, true);
  dv.setUint8(4, sp.version);
  dv.setUint8(5, sp.reserved0 ?? rec);
  dv.setUint16(6, hdrSize, true);
  const interval = sp.interval ?? 250;
  dv.setUint16(8, interval, true);
  dv.setUint32(12, sp.mask, true);
  const last = sp.samples[sp.samples.length - 1];
  dv.setUint32(16, sp.unpatched ? 0 : sp.samples.length, true);
  dv.setUint32(20, sp.unpatched ? 0 : last.t, true);
  dv.setUint32(24, sp.startEpoch, true);
  buf.set(enc.encode(sp.profileId).subarray(0, 31), 28);
  buf.set(enc.encode(sp.profileName).subarray(0, 47), 60);
  dv.setUint16(108, sp.unpatched ? 0 : last.v, true);
  if (sp.version >= 5) {
    sp.phases.forEach((p, i) => {
      const o = 110 + i * 29;
      dv.setUint16(o, p.sampleIndex, true);
      dv.setUint8(o + 2, i);
      dv.setUint8(o + 3, p.reason);
      buf.set(enc.encode(p.name).subarray(0, 24), o + 4);
    });
    dv.setUint8(110 + 12 * 29, sp.phases.length);
    dv.setUint8(110 + 12 * 29 + 1, sp.finalExitReason);
    dv.setUint16(110 + 12 * 29 + 2, sp.brewDelayMs, true);
  }
  sp.samples.forEach((s, i) => {
    let o = hdrSize + i * rec;
    if (hasT) {
      if (elapsed) { dv.setUint32(o, s.t, true); o += 4; }
      else { dv.setUint16(o, Math.round(s.t / interval), true); o += 2; }
    }
    ORDER.forEach((k, bi) => {
      if (!(sp.mask & (1 << (bi + 1)))) return;
      if (SIGNED.has(k)) dv.setInt16(o, s[k], true); else dv.setUint16(o, s[k], true);
      o += 2;
    });
  });
  return buf;
}

export interface IdxRow { id: number; ts: number; dur: number; vol: number; rating: number; flags: number; pid: string; pname: string; avgTemp: number; maxP: number; avgFlow: number }
export function encodeIndex(rows: IdxRow[], nextId: number): Uint8Array {
  const buf = new Uint8Array(32 + 128 * rows.length);
  const dv = new DataView(buf.buffer);
  const enc = new TextEncoder();
  dv.setUint32(0, 0x58444953, true); dv.setUint16(4, 1, true); dv.setUint16(6, 128, true);
  dv.setUint32(8, rows.length, true); dv.setUint32(12, nextId, true);
  rows.forEach((r, i) => {
    const b = 32 + i * 128;
    dv.setUint32(b, r.id, true); dv.setUint32(b + 4, r.ts, true); dv.setUint32(b + 8, r.dur, true);
    dv.setUint16(b + 12, r.vol, true); dv.setUint8(b + 14, r.rating); dv.setUint8(b + 15, r.flags);
    buf.set(enc.encode(r.pid).subarray(0, 31), b + 16); buf.set(enc.encode(r.pname).subarray(0, 47), b + 48);
    dv.setUint16(b + 96, r.avgTemp, true); dv.setUint16(b + 98, r.maxP, true); dv.setUint16(b + 100, r.avgFlow, true);
  });
  return buf;
}

const EPOCH = 1760000000; // 2025-10-09T08:53:20Z
const PHASES = [
  { sampleIndex: 0, name: 'Pre-infusion', reason: 0 },
  { sampleIndex: 24, name: 'Ramp', reason: 5 },
  { sampleIndex: 36, name: 'Extraction', reason: 5 },
];
const base = { startEpoch: EPOCH, profileId: 'classic-9bar', profileName: 'Classic 9 Bar', phases: PHASES, finalExitReason: 1, brewDelayMs: 1000 };

const full = synthSamples(30);
const files: Record<string, Uint8Array> = {
  // current format: v8, 30-byte records, all 14 fields
  '000123.slog': encodeShot({ ...base, version: 8, mask: 0x3fff, samples: full }),
  // v7: same layout, older version number
  '000122.slog': encodeShot({ ...base, version: 7, mask: 0x3fff, samples: full, startEpoch: EPOCH - 86400 }),
  // upstream v6: 28-byte records (13 fields + uint32 t), no wp
  '000121.slog': encodeShot({ ...base, version: 6, mask: 0x1fff, samples: full.map(s => ({ ...s, wp: 0 })), startEpoch: EPOCH - 2 * 86400 }),
  // legacy scale v6: 26-byte records, uint16 tick index
  '000120.slog': encodeShot({ ...base, version: 6, reserved0: 26, mask: 0x1fff, samples: full.map(s => ({ ...s, wp: 0 })), startEpoch: EPOCH - 3 * 86400 }),
  // v5: 512 header, 26-byte records
  '000119.slog': encodeShot({ ...base, version: 5, mask: 0x1fff, samples: full.map(s => ({ ...s, wp: 0 })), startEpoch: EPOCH - 4 * 86400 }),
  // v4: 128-byte header, no phases
  '000118.slog': encodeShot({ ...base, version: 4, mask: 0x1fff, phases: [], samples: full.map(s => ({ ...s, wp: 0 })), startEpoch: EPOCH - 5 * 86400 }),
  // no scale: mask omits vf, v, ev (bits 8,9,10) and wp; v8 so t is uint32
  '000124.slog': encodeShot({ ...base, version: 8, mask: 0x3fff & ~(0x100 | 0x200 | 0x400) & ~0x2000, samples: synthSamples(30, false), startEpoch: EPOCH + 3600 }),
  // header never patched (power loss while recording): sampleCount = 0
  '000125.slog': encodeShot({ ...base, version: 8, mask: 0x3fff, samples: full.slice(0, 40), unpatched: true, startEpoch: EPOCH + 7200 }),
};
for (const [n, b] of Object.entries(files)) writeFileSync(join(dir, n), b);

const rows: IdxRow[] = [
  { id: 123, ts: EPOCH, dur: 29750, vol: 360, rating: 4, flags: 0x05, pid: 'classic-9bar', pname: 'Classic 9 Bar', avgTemp: 931, maxP: 90, avgFlow: 150 },
  { id: 122, ts: EPOCH - 86400, dur: 29750, vol: 360, rating: 0, flags: 0x03, pid: 'classic-9bar', pname: 'Classic 9 Bar', avgTemp: 930, maxP: 90, avgFlow: 150 },
  { id: 121, ts: EPOCH - 172800, dur: 29750, vol: 0, rating: 0, flags: 0x01, pid: 'classic-9bar', pname: 'Café Lungo', avgTemp: 0, maxP: 0, avgFlow: 0 },
];
writeFileSync(join(dir, 'index.bin'), encodeIndex(rows, 126));
writeFileSync(join(dir, 'recent.bin'), (() => { const b = encodeIndex(rows.slice(0, 2), 0); return b; })());

const shot = parseShot(files['000123.slog'], 123);
writeFileSync(join(dir, 'sample-shot.json'), JSON.stringify(shot, null, 1) + '\n');
console.log('fixtures written to', dir);
