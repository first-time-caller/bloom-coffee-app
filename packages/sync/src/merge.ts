/**
 * Field-level conflict resolution. Pure, deterministic, no I/O.
 *
 * Every document body is a set of top-level fields. Each field is a last-writer-wins register stamped with
 * [hlc, deviceId]; stamps are totally ordered (hlc string first, then deviceId), so every device picks the same winner.
 * A field deletion is a stamp with no value. A document delete is a document-level stamp `del`: it hides every field
 * stamped before it, and loses to any field written after it. Arrays and nested objects are one field (replaced whole).
 * mergeStates is a join: commutative, associative and idempotent, so devices converge in any exchange order.
 *
 * Wire form (inside the encrypted payload): { ...fields, _m: { field: [hlc, deviceId] }, _del?: [hlc, deviceId] }.
 * A body without `_m` (older client) counts as every field stamped HLC 0.
 */
export type Stamp = [hlc: string, device: string];
export interface DocState { f: Record<string, unknown>; m: Record<string, Stamp>; del: Stamp | null }

export const ZERO: Stamp = ['0', ''];
export const RESERVED = ['_m', '_del'];

export const cmpStamp = (a: Stamp, b: Stamp): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
const maxStamp = (a: Stamp | null, b: Stamp | null): Stamp | null => (!a ? b : !b ? a : cmpStamp(a, b) >= 0 ? a : b);
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const json = (v: unknown) => JSON.stringify(v);

export const emptyState = (): DocState => ({ f: {}, m: {}, del: null });

export function mergeStates(a: DocState, b: DocState): DocState {
  const out: DocState = { f: {}, m: {}, del: maxStamp(a.del, b.del) };
  const keys = new Set([...Object.keys(a.m), ...Object.keys(a.f), ...Object.keys(b.m), ...Object.keys(b.f)]);
  for (const k of keys) {
    const sa = a.m[k] ?? ZERO, sb = b.m[k] ?? ZERO, c = cmpStamp(sa, sb);
    let win: DocState = c >= 0 ? a : b, stamp = c >= 0 ? sa : sb;
    if (c === 0) {
      // identical stamp, different content can only come from unstamped legacy data: break the tie symmetrically
      const ha = has(a.f, k), hb = has(b.f, k);
      if (ha !== hb) win = ha ? a : b;
      else if (ha && json(a.f[k]) !== json(b.f[k])) win = json(a.f[k]) > json(b.f[k]) ? a : b;
    }
    out.m[k] = [stamp[0], stamp[1]];
    if (has(win.f, k)) out.f[k] = win.f[k];
  }
  return out;
}

/** The fields a user sees: those not hidden by a later-or-equal document delete. */
export function visibleFields(s: DocState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(s.f)) if (!s.del || cmpStamp(s.m[k] ?? ZERO, s.del) > 0) out[k] = s.f[k];
  return out;
}

/** Alive unless a document delete hides everything. */
export const isLive = (s: DocState): boolean => !s.del || Object.keys(visibleFields(s)).length > 0;

/** Drop the values a delete hides (so a deleted document does not keep its data), keeping stamps so stale copies cannot resurrect them. */
export function compact(s: DocState): DocState {
  return { f: visibleFields(s), m: s.m, del: s.del };
}

export function fromWire(plain: Record<string, unknown>): DocState {
  const rawM = plain._m && typeof plain._m === 'object' && !Array.isArray(plain._m) ? (plain._m as Record<string, unknown>) : {};
  const st = (x: unknown): Stamp | null => (Array.isArray(x) && typeof x[0] === 'string' && typeof x[1] === 'string' ? [x[0], x[1]] : null);
  const s = emptyState();
  for (const k of Object.keys(plain)) if (!RESERVED.includes(k)) { s.f[k] = plain[k]; s.m[k] = st(rawM[k]) ?? ZERO; }
  for (const k of Object.keys(rawM)) if (!has(s.m, k) && !RESERVED.includes(k)) { const x = st(rawM[k]); if (x) s.m[k] = x; }
  s.del = st(plain._del);
  return s;
}

export function toWire(s: DocState): Record<string, unknown> {
  const c = compact(s);
  const out: Record<string, unknown> = { ...c.f, _m: c.m };
  if (c.del) out._del = c.del;
  return out;
}

/* ---------- local operations as deltas, merged into the current state ---------- */
export interface OpLike { op: 'set' | 'update' | 'delete'; data?: Record<string, unknown>; hlc: string; fm?: Record<string, string> }

export function deltaFor(op: OpLike, base: DocState, device: string): DocState {
  const d = emptyState();
  if (op.op === 'delete') { d.del = [op.hlc, device]; return d; }
  const data = op.data ?? {};
  for (const k of Object.keys(data)) {
    if (RESERVED.includes(k)) continue;
    d.f[k] = JSON.parse(JSON.stringify(data[k]));
    d.m[k] = [op.fm?.[k] ?? op.hlc, device];
  }
  if (op.op === 'set') for (const k of new Set([...Object.keys(base.m), ...Object.keys(base.f)])) if (!has(d.m, k)) d.m[k] = [op.hlc, device]; // fields not in the new body are deleted
  return d;
}
export const applyOp = (base: DocState, op: OpLike, device: string): DocState => mergeStates(base, deltaFor(op, base, device));

/* ---------- hybrid logical clock ---------- */
export interface HlcState { wall: number; counter: number }
const fmt = (wall: number, counter: number) => String(wall).padStart(15, '0') + '.' + counter.toString(16).padStart(5, '0');
export const MAX_FUTURE_MS = 24 * 3600 * 1000;

export function parseHlc(h: string): HlcState {
  const m = /^(\d{1,15})\.([0-9a-f]{1,5})$/.exec(h);
  return m ? { wall: Number(m[1]), counter: parseInt(m[2], 16) } : { wall: 0, counter: 0 };
}

/** Monotonic per device. tick() stamps a local event; recv() folds in a stamp seen on another device's data. */
export class Hlc {
  constructor(public state: HlcState = { wall: 0, counter: 0 }) {}
  tick(now: number): string {
    if (now > this.state.wall) { this.state.wall = now; this.state.counter = 0; } else this.state.counter++;
    return fmt(this.state.wall, this.state.counter);
  }
  recv(remote: string, now: number): void {
    const r = parseHlc(remote);
    if (r.wall > now + MAX_FUTURE_MS) return; // a wildly wrong remote clock must not drag ours into the far future
    const wall = Math.max(this.state.wall, r.wall, now);
    if (wall === this.state.wall && wall === r.wall) this.state.counter = Math.max(this.state.counter, r.counter) + 1;
    else if (wall === this.state.wall) this.state.counter++;
    else if (wall === r.wall) this.state.counter = r.counter + 1;
    else this.state.counter = 0;
    this.state.wall = wall;
  }
}

/** Highest HLC stamped anywhere in a state (used to advance the local clock on receive). */
export function maxHlc(s: DocState): string {
  let h = '0';
  for (const k of Object.keys(s.m)) if (s.m[k][0] > h) h = s.m[k][0];
  if (s.del && s.del[0] > h) h = s.del[0];
  return h;
}
