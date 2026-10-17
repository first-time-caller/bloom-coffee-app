import type { EspressoCurve, Shot, ShotIndexEntry, ShotPhase, ShotSample } from '../../contract/src/index.ts';

export type { EspressoCurve, Shot, ShotIndexEntry, ShotPhase, ShotSample };

/** Thrown for any malformed / truncated input. `code` is machine-readable. */
export class SlogError extends Error {
  code: 'BAD_MAGIC' | 'TRUNCATED' | 'UNSUPPORTED' | 'CORRUPT';
  constructor(code: SlogError['code'], message: string) {
    super(message);
    this.name = 'SlogError';
    this.code = code;
  }
}

export interface ParseOptions {
  /** Accept files whose sample area is shorter than the header's sampleCount (default false). */
  allowPartial?: boolean;
}

const SHOT_MAGIC = 0x544f4853;
const INDEX_MAGIC = 0x58444953;
const HEADER_V1_4 = 128;
const HEADER_V5 = 512;
const TRANSITIONS_OFFSET = 110;
const TRANSITION_SIZE = 29;
const MAX_TRANSITIONS = 12;
const INDEX_HEADER_SIZE = 32;
const INDEX_ENTRY_SIZE = 128;
const FLAG_DELETED = 0x02;

type Key = keyof ShotSample;
interface FieldDef { bit: number; key: Key; signed: boolean; div: number }
// Order = bit order = on-disk order (after/at t).
const FIELDS: FieldDef[] = [
  { bit: 1, key: 'tt', signed: false, div: 10 },
  { bit: 2, key: 'ct', signed: false, div: 10 },
  { bit: 3, key: 'tp', signed: false, div: 10 },
  { bit: 4, key: 'cp', signed: false, div: 10 },
  { bit: 5, key: 'fl', signed: true, div: 100 },
  { bit: 6, key: 'tf', signed: true, div: 100 },
  { bit: 7, key: 'pf', signed: true, div: 100 },
  { bit: 8, key: 'vf', signed: true, div: 100 },
  { bit: 9, key: 'v', signed: false, div: 10 },
  { bit: 10, key: 'ev', signed: false, div: 10 },
  { bit: 11, key: 'pr', signed: false, div: 100 },
  { bit: 12, key: 'si', signed: false, div: 1 },
  { bit: 13, key: 'wp', signed: false, div: 10 },
];

function toView(buf: ArrayBuffer | Uint8Array): DataView {
  if (buf instanceof Uint8Array) return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf instanceof ArrayBuffer) return new DataView(buf);
  throw new SlogError('CORRUPT', 'Expected an ArrayBuffer or Uint8Array');
}

function cstr(view: DataView, off: number, max: number): string {
  let end = 0;
  while (end < max && view.getUint8(off + end) !== 0) end++;
  return new TextDecoder('utf-8').decode(new Uint8Array(view.buffer, view.byteOffset + off, end));
}

function iso(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}

function popcount(n: number): number {
  let c = 0;
  for (let x = n >>> 0; x; x >>>= 1) c += x & 1;
  return c;
}

export function parseShot(buf: ArrayBuffer | Uint8Array, id = 0, opts: ParseOptions = {}): Shot {
  const view = toView(buf);
  const len = view.byteLength;
  if (len < 16) throw new SlogError('TRUNCATED', `File too small for a .slog header (${len} bytes)`);
  const magic = view.getUint32(0, true);
  if (magic !== SHOT_MAGIC) {
    throw new SlogError('BAD_MAGIC', `Bad .slog magic 0x${magic.toString(16)} (expected 0x${SHOT_MAGIC.toString(16)})`);
  }
  const version = view.getUint8(4);
  const recordedSize = view.getUint8(5);
  const headerSize = view.getUint16(6, true);
  if (version < 1) throw new SlogError('UNSUPPORTED', `Unsupported .slog version ${version}`);
  const wantHeader = version <= 4 ? HEADER_V1_4 : HEADER_V5;
  if (headerSize !== wantHeader) {
    throw new SlogError('CORRUPT', `Header size ${headerSize} does not match v${version} (expected ${wantHeader})`);
  }
  if (len < headerSize) {
    throw new SlogError('TRUNCATED', `Truncated header: need ${headerSize} bytes, got ${len}`);
  }

  const sampleInterval = view.getUint16(8, true);
  const fieldsMask = view.getUint32(12, true);
  const sampleCount = view.getUint32(16, true);
  const durationHdr = view.getUint32(20, true);
  const startEpoch = view.getUint32(24, true);
  const profileId = cstr(view, 28, 32);
  const profileName = cstr(view, 60, 48);
  const finalWeightRaw = view.getUint16(108, true);

  let phaseRaw: { sampleIndex: number; phaseNumber: number; reason: number; name: string }[] = [];
  let finalExitReason = 0;
  let brewDelayMs = 0;
  if (version >= 5) {
    const countOff = TRANSITIONS_OFFSET + MAX_TRANSITIONS * TRANSITION_SIZE;
    const n = Math.min(view.getUint8(countOff), MAX_TRANSITIONS);
    finalExitReason = view.getUint8(countOff + 1);
    brewDelayMs = view.getUint16(countOff + 2, true);
    for (let i = 0; i < n; i++) {
      const o = TRANSITIONS_OFFSET + i * TRANSITION_SIZE;
      phaseRaw.push({
        sampleIndex: view.getUint16(o, true),
        phaseNumber: view.getUint8(o + 2),
        reason: view.getUint8(o + 3),
        name: cstr(view, o + 4, 25),
      });
    }
  }

  // Record layout. From v6 the timestamp is uint32 ms, except "legacy scale v6"
  // (record size 26, mask 0x1FFF) which still stores a uint16 sample index.
  const legacyV6 = version === 6 && recordedSize === 26 && fieldsMask === 0x1fff;
  const elapsedMs = version >= 6 && !legacyV6;
  const hasT = (fieldsMask & 1) !== 0;
  let recSize = popcount(fieldsMask) * 2 + (hasT && elapsedMs ? 2 : 0);
  if (!hasT && recSize === 0) throw new SlogError('CORRUPT', 'fieldsMask selects no fields');
  if (recordedSize !== 0 && recordedSize !== recSize) {
    throw new SlogError('CORRUPT', `Header sample size ${recordedSize} contradicts fieldsMask 0x${fieldsMask.toString(16)} (${recSize} bytes)`);
  }

  const dataBytes = len - headerSize;
  const available = Math.floor(dataBytes / recSize);
  if (sampleCount > available && !opts.allowPartial) {
    throw new SlogError('TRUNCATED', `Truncated sample data: header declares ${sampleCount} samples, file holds ${available}`);
  }
  const n = sampleCount > 0 ? Math.min(sampleCount, available) : available;

  // Per-record offsets of each known field (unknown mask bits are 2-byte, skipped).
  const present: { def: FieldDef; off: number }[] = [];
  let off = hasT ? (elapsedMs ? 4 : 2) : 0;
  for (let bit = 1; bit < 32; bit++) {
    if (!(fieldsMask & (1 << bit))) continue;
    const def = FIELDS.find(f => f.bit === bit);
    if (def) present.push({ def, off });
    off += 2;
  }

  const samples: ShotSample[] = [];
  for (let i = 0; i < n; i++) {
    const base = headerSize + i * recSize;
    let t: number;
    if (!hasT) t = i * sampleInterval;
    else if (elapsedMs) t = view.getUint32(base, true);
    else t = view.getUint16(base, true) * sampleInterval;
    const s: ShotSample = { t };
    for (const { def, off: o } of present) {
      const raw = def.signed ? view.getInt16(base + o, true) : view.getUint16(base + o, true);
      s[def.key] = def.div === 1 ? raw : raw / def.div;
    }
    samples.push(s);
  }

  const last = samples.length ? samples[samples.length - 1] : undefined;
  const lastT = last ? last.t : 0;
  const complete = sampleCount > 0 && n === sampleCount;
  const durationMs = complete && durationHdr > 0 ? durationHdr : lastT;

  const phases: ShotPhase[] = phaseRaw.map(p => {
    const idx = Math.min(p.sampleIndex, Math.max(samples.length - 1, 0));
    return {
      sampleIndex: p.sampleIndex,
      tMs: samples.length ? samples[idx].t : 0,
      phaseNumber: p.phaseNumber,
      phaseName: p.name,
      reason: p.reason,
    };
  });

  let finalWeightG: number | null = null;
  if (finalWeightRaw > 0) finalWeightG = finalWeightRaw / 10;
  else if (last && last.v !== undefined && last.v > 0) finalWeightG = last.v;

  return {
    id,
    version,
    startedAt: iso(startEpoch),
    durationMs,
    sampleIntervalMs: sampleInterval,
    profileId,
    profileName,
    brewDelayMs,
    finalWeightG,
    finalExitReason,
    phases,
    samples,
  };
}

/** Parses index.bin and recent.bin (same SIDX layout). Deleted entries are included, flagged. */
export function parseIndex(buf: ArrayBuffer | Uint8Array): ShotIndexEntry[] {
  const view = toView(buf);
  if (view.byteLength < INDEX_HEADER_SIZE) throw new SlogError('TRUNCATED', 'Index file too small');
  const magic = view.getUint32(0, true);
  if (magic !== INDEX_MAGIC) {
    throw new SlogError('BAD_MAGIC', `Bad index magic 0x${magic.toString(16)} (expected 0x${INDEX_MAGIC.toString(16)})`);
  }
  const entrySize = view.getUint16(6, true);
  const count = view.getUint32(8, true);
  if (entrySize !== INDEX_ENTRY_SIZE) {
    throw new SlogError('UNSUPPORTED', `Unsupported index entry size ${entrySize} (expected ${INDEX_ENTRY_SIZE})`);
  }
  const avail = Math.floor((view.byteLength - INDEX_HEADER_SIZE) / INDEX_ENTRY_SIZE);
  if (count > avail) {
    throw new SlogError('TRUNCATED', `Index truncated: header declares ${count} entries, file holds ${avail}`);
  }
  const out: ShotIndexEntry[] = [];
  for (let i = 0; i < count; i++) {
    const b = INDEX_HEADER_SIZE + i * INDEX_ENTRY_SIZE;
    const volume = view.getUint16(b + 12, true);
    out.push({
      id: view.getUint32(b, true),
      startedAt: iso(view.getUint32(b + 4, true)),
      durationMs: view.getUint32(b + 8, true),
      profileName: cstr(view, b + 48, 48),
      finalWeightG: volume > 0 ? volume / 10 : null,
      rating: view.getUint8(b + 14),
      volumeG: volume > 0 ? volume / 10 : null,
      deleted: (view.getUint8(b + 15) & FLAG_DELETED) !== 0,
    });
  }
  return out;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/** Resample onto a fixed grid (t = 0, step, 2*step ... <= durationMs). null where a field was never recorded. */
export function shotToCurve(shot: Shot, stepMs = 500): EspressoCurve {
  if (!(stepMs > 0)) throw new SlogError('CORRUPT', 'stepMs must be > 0');
  const S = shot.samples;
  const series = {
    p: S.map(s => s.cp),
    f: S.map(s => s.pf ?? s.fl),
    w: S.map(s => s.v),
    c: S.map(s => s.ct),
  };
  const end = S.length ? Math.max(shot.durationMs, S[S.length - 1].t) : 0;
  const nPts = S.length ? Math.floor(end / stepMs) + 1 : 0;
  const out: EspressoCurve = { stepMs, p: [], f: [], w: [], c: [] };
  for (const k of ['p', 'f', 'w', 'c'] as const) {
    const ys = series[k];
    if (!ys.some(y => y !== undefined)) {
      out[k] = new Array(nPts).fill(null);
      continue;
    }
    let j = 0;
    for (let g = 0; g < nPts; g++) {
      const t = g * stepMs;
      while (j < S.length - 2 && S[j + 1].t <= t) j++;
      let v: number | null = null;
      if (S.length === 1) v = ys[0] ?? null;
      else {
        const a = S[j], b = S[j + 1];
        const ya = ys[j], yb = ys[j + 1];
        if (t <= a.t) v = ya ?? null;
        else if (t >= b.t) v = yb ?? null;
        else if (ya === undefined || yb === undefined) v = (ya ?? yb) ?? null;
        else v = ya + ((yb - ya) * (t - a.t)) / (b.t - a.t);
      }
      out[k].push(v === null ? null : r1(v));
    }
  }
  return out;
}

export interface ShotSummary {
  /** Total recorded shot time in seconds, including brew delay (matches GaggiMate UI). */
  timeS: number;
  yieldG: number | null;
  peakPressureBar: number | null;
  avgTempC: number | null;
}

export function summarizeShot(shot: Shot): ShotSummary {
  let peak: number | null = null;
  let sum = 0, n = 0;
  for (const s of shot.samples) {
    if (s.cp !== undefined && (peak === null || s.cp > peak)) peak = s.cp;
    if (s.ct !== undefined) { sum += s.ct; n++; }
  }
  return {
    timeS: r1(shot.durationMs / 1000),
    yieldG: shot.finalWeightG,
    peakPressureBar: peak === null ? null : r1(peak),
    avgTempC: n ? r1(sum / n) : null,
  };
}

export function slogPath(id: number): string {
  return `/api/history/${String(Math.trunc(id)).padStart(6, '0')}.slog`;
}
