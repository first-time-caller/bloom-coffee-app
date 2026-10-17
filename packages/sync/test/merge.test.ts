import { describe, expect, it } from 'vitest';
import { Hlc, applyOp, cmpStamp, compact, emptyState, fromWire, isLive, maxHlc, mergeStates, parseHlc, toWire, visibleFields, type DocState, type OpLike } from '../src/merge.ts';
import { FakeServer, makeDevice, until } from './harness.ts';

/* tiny seeded PRNG so failures reproduce */
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const view = (s: DocState) => JSON.stringify([isLive(s), Object.entries(visibleFields(s)).sort(), Object.entries(s.m).sort(), s.del]);
const FIELDS = ['a', 'b', 'c', 'd'];

function randomOp(r: () => number, hlc: Hlc, now: number): OpLike {
  const kind = r();
  const hl = hlc.tick(now);
  if (kind < 0.12) return { op: 'delete', hlc: hl };
  const data: Record<string, unknown> = {};
  for (const f of FIELDS) if (r() < 0.5) data[f] = r() < 0.2 ? [1, { x: Math.floor(r() * 3) }] : Math.floor(r() * 5);
  return { op: kind < 0.4 ? 'set' : 'update', data, hlc: hl };
}
function randomState(r: () => number, dev: string): DocState {
  let s = emptyState();
  const h = new Hlc();
  const n = Math.floor(r() * 5);
  for (let i = 0; i < n; i++) s = applyOp(s, randomOp(r, h, Math.floor(r() * 50)), dev);
  return s;
}

describe('merge is a join (property tests)', () => {
  it('is commutative, idempotent and associative over random states', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed);
      const a = randomState(r, 'A'), b = randomState(r, 'B'), c = randomState(r, 'C');
      expect(view(mergeStates(a, b)), 'commutative ' + seed).toBe(view(mergeStates(b, a)));
      expect(view(mergeStates(a, a)), 'idempotent ' + seed).toBe(view(a));
      expect(view(mergeStates(mergeStates(a, b), c)), 'associative ' + seed).toBe(view(mergeStates(a, mergeStates(b, c))));
      // compacting (what is written to the server) never changes what anyone sees
      expect(view(mergeStates(compact(a), compact(b)))).toBe(view(mergeStates(a, b)).replace(/x/g, 'x'));
    }
  });

  it('converges across 2-3 devices with random interleavings and skewed clocks', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed * 7919);
      const nDev = 2 + Math.floor(r() * 2);
      const devs = Array.from({ length: nDev }, (_, i) => ({ id: 'dev' + i, hlc: new Hlc(), skew: Math.floor((r() - 0.5) * 100_000), state: emptyState() }));
      let t = 1_000_000;
      for (let step = 0; step < 40; step++) {
        t += Math.floor(r() * 20);
        const d = devs[Math.floor(r() * nDev)];
        if (r() < 0.65) d.state = applyOp(d.state, randomOp(r, d.hlc, t + d.skew), d.id);
        else {
          // a sync: d receives another device's state (any order, any time; may repeat or be stale)
          const o = devs[Math.floor(r() * nDev)];
          if (o !== d) { d.hlc.recv(maxHlc(o.state), t + d.skew); d.state = mergeStates(d.state, o.state); }
        }
      }
      // final all-to-all exchange in a random order, twice
      for (let round = 0; round < 2; round++) for (const d of devs.slice().sort(() => r() - 0.5)) for (const o of devs) d.state = mergeStates(d.state, o.state);
      for (const d of devs) expect(view(d.state), 'seed ' + seed).toBe(view(devs[0].state));
    }
  });

  it('a clock far behind cannot keep losing once it has seen newer data (HLC receive)', () => {
    const slow = new Hlc(), fast = new Hlc();
    let sa = applyOp(emptyState(), { op: 'set', data: { a: 'fast' }, hlc: fast.tick(2_000_000) }, 'F');
    slow.recv(maxHlc(sa), 1_000); // the slow device syncs and sees the fast device's data
    const edit = slow.tick(1_001); // its next edit is stamped after what it saw, despite its slow wall clock
    const sb = applyOp(sa, { op: 'update', data: { a: 'slow-later' }, hlc: edit }, 'S');
    expect(visibleFields(mergeStates(sa, sb))).toEqual({ a: 'slow-later' });
    // without receive it would have lost
    const lost = applyOp(sa, { op: 'update', data: { a: 'stale' }, hlc: new Hlc().tick(1_001) }, 'S');
    expect(visibleFields(mergeStates(sa, lost))).toEqual({ a: 'fast' });
  });

  it('ignores an absurd future timestamp instead of adopting it', () => {
    const h = new Hlc();
    h.recv('999999999999999.00000', 1000);
    expect(h.state.wall).toBeLessThan(1_000_000);
    expect(parseHlc('garbage')).toEqual({ wall: 0, counter: 0 });
  });

  it('HLC is monotonic with equal wall times and counters tie-break', () => {
    const h = new Hlc();
    const a = h.tick(5), b = h.tick(5), c = h.tick(4);
    expect(a < b && b < c).toBe(true);
    const h2 = new Hlc({ wall: 10, counter: 3 });
    h2.recv('000000000000010.00007', 10); expect(h2.state).toEqual({ wall: 10, counter: 8 });
    h2.recv('000000000000010.00001', 10); expect(h2.state).toEqual({ wall: 10, counter: 9 });
    h2.recv('000000000000012.00002', 10); expect(h2.state).toEqual({ wall: 12, counter: 3 });
    h2.recv('000000000000001.00002', 50); expect(h2.state).toEqual({ wall: 50, counter: 0 });
  });
});

describe('merge rules', () => {
  const H = (n: number) => String(n).padStart(15, '0') + '.00000';
  it('higher stamp wins per field; ties break on device id', () => {
    const a = applyOp(emptyState(), { op: 'set', data: { x: 1, y: 1 }, hlc: H(1) }, 'A');
    const b = applyOp(a, { op: 'update', data: { x: 2 }, hlc: H(2) }, 'B');
    const c = applyOp(a, { op: 'update', data: { y: 9 }, hlc: H(3) }, 'C');
    expect(visibleFields(mergeStates(b, c))).toEqual({ x: 2, y: 9 });
    const t1 = applyOp(emptyState(), { op: 'update', data: { z: 'from A' }, hlc: H(5) }, 'A');
    const t2 = applyOp(emptyState(), { op: 'update', data: { z: 'from B' }, hlc: H(5) }, 'B');
    expect(visibleFields(mergeStates(t1, t2))).toEqual({ z: 'from B' });
    expect(cmpStamp(['1', 'a'], ['1', 'a'])).toBe(0);
  });
  it('set removes fields it does not mention (field tombstones); arrays and objects are replaced whole', () => {
    const a = applyOp(emptyState(), { op: 'set', data: { x: [1, 2], y: { n: 1, k: 2 }, z: 1 }, hlc: H(1) }, 'A');
    const b = applyOp(a, { op: 'set', data: { x: [3], y: { n: 2 } }, hlc: H(2) }, 'A');
    expect(visibleFields(b)).toEqual({ x: [3], y: { n: 2 } });
    const stale = mergeStates(b, a);
    expect(visibleFields(stale)).toEqual({ x: [3], y: { n: 2 } });
  });
  it('a delete beats older edits and loses to newer ones', () => {
    const base = applyOp(emptyState(), { op: 'set', data: { a: 1, b: 2 }, hlc: H(1) }, 'A');
    const del = applyOp(base, { op: 'delete', hlc: H(5) }, 'A');
    expect(isLive(del)).toBe(false);
    const older = applyOp(base, { op: 'update', data: { a: 'old edit' }, hlc: H(4) }, 'B');
    expect(isLive(mergeStates(del, older))).toBe(false);
    const newer = applyOp(base, { op: 'update', data: { a: 'after delete' }, hlc: H(6) }, 'B');
    const m = mergeStates(del, newer);
    expect(isLive(m)).toBe(true);
    expect(visibleFields(m)).toEqual({ a: 'after delete' }); // b was older than the delete and stays gone
    const reborn = applyOp(del, { op: 'set', data: { c: 3 }, hlc: H(7) }, 'A');
    expect(visibleFields(reborn)).toEqual({ c: 3 });
  });
  it('compact drops hidden values but not stamps; wire form round-trips; legacy bodies count as HLC 0', () => {
    const del = applyOp(applyOp(emptyState(), { op: 'set', data: { secret: 'x' }, hlc: H(1) }, 'A'), { op: 'delete', hlc: H(2) }, 'A');
    const w = toWire(del);
    expect(w).not.toHaveProperty('secret');
    expect(JSON.stringify(w)).not.toContain('"x"');
    expect(w._del).toEqual([H(2), 'A']);
    const back = fromWire(w);
    expect(view(back)).toBe(view(compact(del)));
    const legacy = fromWire({ name: 'Brad', _m: 'junk' });
    expect(legacy.m.name).toEqual(['0', '']);
    expect(maxHlc(legacy)).toBe('0');
    const overwritten = applyOp(legacy, { op: 'update', data: { name: 'New' }, hlc: H(1) }, 'A');
    expect(visibleFields(mergeStates(legacy, overwritten))).toEqual({ name: 'New' });
    expect(visibleFields(fromWire({ a: 1, _m: { a: [H(1), 'A'], gone: [H(2), 'A'] }, _del: 'bad' }))).toEqual({ a: 1 });
    expect(maxHlc(fromWire({ a: 1, _m: { a: [H(1), 'A'] }, _del: [H(9), 'A'] }))).toBe(H(9));
    // reserved keys in user data are never stored as fields
    expect(visibleFields(applyOp(emptyState(), { op: 'set', data: { _m: 1, _del: 2, ok: 3 }, hlc: H(1) }, 'A'))).toEqual({ ok: 3 });
    // equal stamps with different legacy values: deterministic either way round
    const l1 = fromWire({ k: 'a' }), l2 = fromWire({ k: 'b' }), l3 = fromWire({}), l4 = { f: {}, m: { k: ['0', ''] as [string, string] }, del: null };
    expect(view(mergeStates(l1, l2))).toBe(view(mergeStates(l2, l1)));
    expect(visibleFields(mergeStates(l3, l4))).toEqual({});
    expect(visibleFields(mergeStates(l1, l4))).toEqual({ k: 'a' });
  });
});

describe('field-level merge through the client', () => {
  const PW = 'correct horse battery';
  it('concurrent edits to different fields on two devices both survive; same field: latest edit wins', async () => {
    const s = new FakeServer();
    const A = makeDevice(s), B = makeDevice(s);
    const u = await A.sync.auth.signup('merge@example.com', PW, '');
    await B.sync.auth.login('merge@example.com', PW);
    const pa = (await A.sync.use('db')).doc(`data/users/${u.id}/settings`), pb = (await B.sync.use('db')).doc(`data/users/${u.id}/settings`);
    await pa.set({ grinder: 'x', units: 'metric', theme: 'light' });
    await B.sync.syncNow();
    s.offline = true;
    await pa.update({ units: 'imperial' }).catch(() => {});
    B.clock.t += 5000; // B's wall clock runs ahead
    await pb.update({ theme: 'dark', units: 'metric-b' }).catch(() => {});
    s.offline = false;
    await A.sync.syncNow(); await B.sync.syncNow(); await A.sync.syncNow();
    await until(() => A.sync.pendingWrites() === 0 && B.sync.pendingWrites() === 0, 'flushed');
    await A.sync.syncNow(); await B.sync.syncNow();
    const wantA = (await pa.get()).data(), wantB = (await pb.get()).data();
    expect(wantA).toEqual(wantB);
    expect(wantA).toEqual({ grinder: 'x', units: 'metric-b', theme: 'dark' }); // B edited later (newer HLC) for the shared field
    expect(Object.keys(wantA as object)).not.toContain('_m');
  });

  it('delete vs later edit across devices: the later edit resurrects only the edited fields', async () => {
    const s = new FakeServer();
    const A = makeDevice(s), B = makeDevice(s);
    const u = await A.sync.auth.signup('del@example.com', PW, '');
    await B.sync.auth.login('del@example.com', PW);
    const pa = (await A.sync.use('db')).doc(`data/users/${u.id}/profile`).collection('bags').doc('b1');
    const pb = (await B.sync.use('db')).doc(`data/users/${u.id}/profile`).collection('bags').doc('b1');
    await pa.set({ name: 'Ethiopia', grams: 250 });
    await B.sync.syncNow();
    await pa.delete();
    expect((await pa.get()).exists).toBe(false);
    B.clock.t += 1000;
    await pb.update({ grams: 200 });
    await A.sync.syncNow(); await B.sync.syncNow();
    expect((await pa.get()).data()).toEqual({ grams: 200 });
    expect((await pb.get()).data()).toEqual({ grams: 200 });
    // the server only ever saw ciphertext, and the deleted fields are not in the payload any more
    expect(JSON.stringify(s.stored('del@example.com', 'bags', 'b1')!.data)).not.toContain('Ethiopia');
  });
});
