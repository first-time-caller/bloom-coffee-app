import { describe, expect, it } from 'vitest';
import * as C from '../src/crypto.ts';
import { planUpload } from '../src/util.ts';
import { FakeServer, cryptoImpl, idle, makeDevice, until, type Device } from './harness.ts';

const PW = 'correct horse battery';
let n = 0;
async function account(server: FakeServer, over: Parameters<typeof makeDevice>[1] = {}) {
  const d = makeDevice(server, over);
  const email = `f${++n}@example.com`;
  const u = await d.sync.auth.signup(email, PW, 'T');
  return { d, uid: u.id, email, db: await d.sync.use('db') };
}
async function second(server: FakeServer, email: string, over: Parameters<typeof makeDevice>[1] = {}) {
  const d = makeDevice(server, over);
  const u = await d.sync.auth.login(email, PW);
  return { d, uid: u.id, db: await d.sync.use('db') };
}
const ids = (s: any) => s.docs.map((x: any) => x.id);
const brews = (db: any, uid: string) => db.doc(`data/users/${uid}/profile`).collection('brews');
const dump = async (d: Device, uid: string, col: string) => Object.fromEntries((await brews(await d.sync.use('db'), uid).get()).docs.map((x: any) => [x.id, x.data()]));

describe('documents', () => {
  it('get/set/update/delete a root doc like Bloom does (profile, settings)', async () => {
    const s = new FakeServer();
    const { d, uid, db } = await account(s);
    const profile = db.doc(`data/users/${uid}/profile`);
    let snap = await profile.get();
    expect(snap.exists).toBe(false);
    expect(snap.data()).toBeUndefined();
    await profile.set({ name: 'Brad', bagsMigrated: false });
    expect((await profile.get()).data()).toEqual({ name: 'Brad', bagsMigrated: false });
    await profile.update({ bagsMigrated: true });
    expect((await profile.get()).data()).toEqual({ name: 'Brad', bagsMigrated: true });
    await expect(db.doc(`data/users/${uid}/nothing`).update({ a: 1 })).rejects.toMatchObject({ code: 'not_found' });
    expect(d.sync.pendingWrites()).toBe(0);
    await profile.delete();
    expect((await profile.get()).exists).toBe(false);
    // the data returned is a copy
    await profile.set({ nested: { a: 1 } });
    const v: any = (await profile.get()).data(); v.nested.a = 99;
    expect(((await profile.get()).data() as any).nested.a).toBe(1);
  });

  it('validates arguments and paths and keeps users apart', async () => {
    const s = new FakeServer();
    const { d, uid, db } = await account(s);
    expect(() => db.doc('weird/path')).toThrowError(/Unsupported document path/);
    await expect(db.doc('data/users/someone-else/profile').get()).rejects.toMatchObject({ code: 'permission-denied' });
    const p = db.doc(`data/users/${uid}/profile`);
    await expect(p.set([] as any)).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(p.update(null as any)).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(() => p.collection('a').doc('x').collection('b')).toThrowError(/Nested/);
    expect(() => p.collection('a').doc('')).toThrowError(/needs an id/);
    await expect(d.sync.use('sample')).rejects.toMatchObject({ code: 'unsupported' });
    expect(await (await d.sync.use('user')).id()).toBe(uid);
    expect((await d.sync.use('user')).current()!.id).toBe(uid);
  });

  it('stores only ciphertext envelopes on the server', async () => {
    const s = new FakeServer();
    const { db, uid, email } = await account(s);
    await db.doc(`data/users/${uid}/profile`).set({ name: 'zz-secret-name' });
    const row = s.stored(email, '_root', 'profile')!;
    expect(Object.keys(row.data).sort()).toEqual(['ct', 'iv', 'v']);
    expect(JSON.stringify(row.data)).not.toContain('secret');
  });

  it('merges update() on the client: other fields written elsewhere survive', async () => {
    const s = new FakeServer();
    const a = await account(s);
    const b = await second(s, a.email);
    await a.db.doc(`data/users/${a.uid}/profile`).set({ name: 'A', keep: 1 });
    await b.d.sync.syncNow();
    await b.db.doc(`data/users/${b.uid}/profile`).update({ extra: 2 });
    await a.d.sync.syncNow();
    expect((await a.db.doc(`data/users/${a.uid}/profile`).get()).data()).toEqual({ name: 'A', keep: 1, extra: 2 });
    const puts = s.log.filter(r => r.method === 'PUT' && r.path.includes('/v1/docs/_root/profile'));
    expect(puts.some(r => r.path.includes('baseSeq='))).toBe(true);
  });

  it('a stale update gets 409 from the server, re-reads the latest and merges again', async () => {
    const s = new FakeServer();
    const a = await account(s);
    const b = await second(s, a.email);
    const pa = a.db.doc(`data/users/${a.uid}/profile`), pb = b.db.doc(`data/users/${b.uid}/profile`);
    await pa.set({ base: true });
    await b.d.sync.syncNow(); // both devices know seq N
    await pb.update({ fromB: 'b' }); // seq N+1
    const before = s.log.length;
    await pa.update({ fromA: 'a' }); // A still believes seq N: stale -> 409 -> refresh -> retry
    const mine = s.log.slice(before);
    expect(mine.some(r => r.method === 'PUT' && r.path.includes('baseSeq='))).toBe(true);
    expect(mine.filter(r => r.method === 'PUT').length).toBeGreaterThanOrEqual(2);
    expect(mine.some(r => r.method === 'GET' && r.path === '/v1/docs/_root/profile')).toBe(true);
    await b.d.sync.syncNow();
    for (const [x, id] of [[pa, a], [pb, b]] as const) expect((await x.get()).data()).toEqual({ base: true, fromB: 'b', fromA: 'a' });
    expect(a.d.sync.pendingWrites()).toBe(0);
  });

  it('gives up after repeated conflicts without losing the queued update', async () => {
    const s = new FakeServer();
    const a = await account(s);
    const p = a.db.doc(`data/users/${a.uid}/profile`);
    await p.set({ x: 1 });
    s.failNext.push({ match: r => r.method === 'PUT' && r.path.includes('baseSeq='), status: 409, code: 'conflict', times: 50 });
    await expect(p.update({ y: 2 })).rejects.toMatchObject({ code: 'conflict' });
    expect(a.d.sync.pendingWrites()).toBe(1); // kept, will retry
    expect(a.d.sync.status().state).toBe('error');
    expect((await p.get()).data()).toEqual({ x: 1, y: 2 }); // still visible locally
  });

  it('drops an op the server permanently refuses (quota) and reports it', async () => {
    const s = new FakeServer();
    const a = await account(s);
    s.failNext.push({ match: r => r.method === 'PUT', status: 409, code: 'quota_exceeded', times: 1 });
    await expect(brews(a.db, a.uid).doc('q').set({ createdAt: '1' })).rejects.toMatchObject({ code: 'quota_exceeded' });
    expect(a.d.sync.pendingWrites()).toBe(0);
    expect((await brews(a.db, a.uid).get()).size).toBe(0);
  });

  it('keeps and retries an op on server errors (5xx) with growing backoff', async () => {
    const s = new FakeServer();
    const a = await account(s);
    s.failNext.push({ match: r => r.method === 'PUT', status: 503, code: 'unavailable_upstream', times: 2 });
    const before = s.log.length;
    await expect(brews(a.db, a.uid).doc('r').set({ createdAt: '1' })).rejects.toMatchObject({ status: 503 });
    expect(a.d.sync.pendingWrites()).toBe(1);
    const puts = () => s.log.slice(before).filter(r => r.method === 'PUT').length;
    expect(puts()).toBe(1);
    await a.d.clock.advance(2900); expect(puts()).toBe(1);
    await a.d.clock.advance(200); await until(() => puts() === 2, 'second attempt after 3s');
    await a.d.clock.advance(5800); expect(puts()).toBe(2); // second backoff is 6s
    await a.d.clock.advance(200); await until(() => a.d.sync.pendingWrites() === 0, 'third attempt succeeds');
    expect(s.stored(a.email, 'brews', 'r')).toBeTruthy();
  });
});

describe('snapshots', () => {
  it('orderBy/limit snapshots follow set/update/delete; first snapshot is the server state; no callbacks after unsubscribe', async () => {
    const s = new FakeServer();
    const { d, db, uid } = await account(s);
    const col = brews(db, uid);
    const snaps: string[][] = [];
    const unsub = col.orderBy('createdAt', 'desc').limit(2).onSnapshot((x: any) => snaps.push(ids(x)), () => { throw new Error('err cb'); });
    await until(() => snaps.length >= 1, 'first snapshot');
    expect(snaps[0]).toEqual([]);
    await col.doc('b1').set({ createdAt: '2026-01-01', dose: 18 });
    await col.doc('b2').set({ createdAt: '2026-01-02', dose: 19 });
    await col.doc('b3').set({ createdAt: '2026-01-03', dose: 20 });
    await until(() => snaps.at(-1)!.join() === 'b3,b2', 'top two');
    await col.doc('b3').update({ dose: 21 });
    await col.doc('b3').delete();
    await until(() => snaps.at(-1)!.join() === 'b2,b1', 'after delete');
    unsub();
    const count = snaps.length;
    await col.doc('b9').set({ createdAt: '2027' });
    await d.clock.advance(5000);
    expect(snaps.length).toBe(count);
    expect(d.sync.pendingWrites()).toBe(0);
  });

  it('collection without orderBy lists by server order; empty and forEach work', async () => {
    const s = new FakeServer();
    const { db, uid } = await account(s);
    const bags = db.doc(`data/users/${uid}/profile`).collection('bags');
    let last: any = null;
    bags.onSnapshot((x: any) => { last = x; });
    await until(() => last, 'first');
    expect(last.empty).toBe(true);
    await bags.doc('x').set({ status: 'open' });
    await bags.doc('y').set({ status: 'finished' });
    await until(() => last.size === 2, 'two bags');
    const seen: string[] = [];
    last.forEach((dd: any) => seen.push(dd.id));
    expect(seen).toEqual(['x', 'y']);
  });

  it('delivers snapshots in order and always reflects the latest state', async () => {
    const s = new FakeServer();
    const { db, uid } = await account(s);
    const col = brews(db, uid);
    const seen: number[] = [];
    col.orderBy('createdAt', 'desc').limit(50).onSnapshot((x: any) => seen.push(x.size));
    await until(() => seen.length === 1, 'first');
    for (let i = 0; i < 6; i++) col.doc('r' + i).set({ createdAt: '2026-01-0' + i });
    await until(() => seen.at(-1) === 6, 'six docs');
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]); // never goes backwards
  });

  it('isolates a throwing listener from the others', async () => {
    const s = new FakeServer();
    const { db, uid } = await account(s);
    const col = brews(db, uid);
    let ok = 0;
    col.onSnapshot(() => { throw new Error('bad listener'); });
    col.onSnapshot(() => { ok++; });
    await until(() => ok >= 1, 'second listener');
    await col.doc('a').set({ createdAt: '1' });
    await until(() => ok >= 2, 'second listener again');
  });

  it('calls the error callback when signed out or locked', async () => {
    const s = new FakeServer();
    const { d, uid, db } = await account(s);
    const col = brews(db, uid);
    await d.sync.auth.logout();
    const e1 = await new Promise<any>(res => col.onSnapshot(() => res(null), (e: any) => res(e)));
    expect(e1.code).toBe('permission-denied');
    const b = makeDevice(s, { kv: d.kv, keys: null });
    const a2 = await account(s, { keys: null });
    a2.d.sync.destroy();
    const locked = makeDevice(s, { kv: a2.d.kv, keys: null });
    await locked.sync.ready;
    const e2 = await new Promise<any>(res => ((locked.sync as any), (async () => (await locked.sync.use('db')).doc(`data/users/${a2.uid}/profile`).collection('brews').onSnapshot(() => res(null), (e: any) => res(e)))()));
    expect(e2.code).toBe('locked');
    b.sync.destroy();
  });
});

describe('first snapshot rules and offline', () => {
  it('offline with no synced cache: error callback; with a synced cache: cached data, no error', async () => {
    const s = new FakeServer();
    const a = await account(s);
    s.offline = true;
    const fresh = await new Promise<any>(res => brews(a.db, a.uid).orderBy('createdAt', 'desc').limit(5).onSnapshot(() => res(null), (e: any) => res(e)));
    expect(fresh.code).toBe('unavailable');
    s.offline = false;
    await brews(a.db, a.uid).doc('c1').set({ createdAt: '1' });
    await a.d.sync.syncNow();
    await a.d.clock.advance(300); // cache persisted
    s.offline = true;
    let got: string[] | null = null;
    brews(a.db, a.uid).onSnapshot((x: any) => { got = ids(x); }, () => { throw new Error('should use cache'); });
    await until(() => got !== null, 'cached snapshot');
    expect(got).toEqual(['c1']);
  });

  it('queues writes offline, shows them at once, survives a reload, and flushes when back online', async () => {
    const s = new FakeServer();
    const a = await account(s);
    const col = brews(a.db, a.uid);
    let seen: string[] = [];
    col.orderBy('createdAt', 'desc').limit(10).onSnapshot((x: any) => { seen = ids(x); });
    await col.doc('on1').set({ createdAt: '1' });
    await until(() => seen.join() === 'on1', 'online doc');
    s.offline = true;
    await expect(col.doc('off1').set({ createdAt: '2' })).rejects.toMatchObject({ code: 'unavailable' });
    await col.doc('off1').set({ createdAt: '2' }).catch(() => {}); // Bloom's retry: coalesced, not duplicated
    await until(() => seen.join() === 'off1,on1', 'optimistic');
    expect(a.d.sync.pendingWrites()).toBe(1);
    expect(a.d.sync.status()).toMatchObject({ state: 'offline', pending: 1 });
    expect(JSON.parse(a.d.kv.m.get('bloomsync:queue')!)).toHaveLength(1);
    a.d.life.fireHide();
    a.d.sync.destroy();

    // reload while still offline
    const r = makeDevice(s, { kv: a.d.kv, keys: a.d.keys, clock: a.d.clock });
    await r.sync.ready;
    expect(r.sync.pendingWrites()).toBe(1);
    let cached: string[] = [];
    (await r.sync.use('db')).doc(`data/users/${a.uid}/profile`).collection('brews').orderBy('createdAt', 'desc').limit(10)
      .onSnapshot((x: any) => { cached = ids(x); }, () => { throw new Error('should fall back to the cache'); });
    await until(() => cached.length > 0, 'cache snapshot');
    expect(cached).toEqual(['off1', 'on1']);

    s.offline = false;
    r.life.fireOnline();
    await until(() => r.sync.pendingWrites() === 0, 'flush after online');
    expect(s.stored(a.email, 'brews', 'off1')).toBeTruthy();
    await until(() => r.sync.status().state === 'synced', 'synced');
  });

  it('publishes status changes: pending -> synced, offline, error, locked, signed-out', async () => {
    const s = new FakeServer();
    const a = await account(s);
    const states = () => a.d.events.filter(e => e.name === 'bloomsync:status').map(e => e.detail.state);
    await brews(a.db, a.uid).doc('x').set({ createdAt: '1' });
    expect(states()).toContain('pending');
    expect(states().at(-1)).toBe('synced');
    s.offline = true;
    await a.d.sync.syncNow();
    expect(states().at(-1)).toBe('offline');
    s.offline = false;
    await a.d.sync.syncNow();
    expect(states().at(-1)).toBe('synced');
    expect(a.d.sync.status().lastSyncAt).not.toBeNull();
    await a.d.sync.auth.logout();
    expect(states().at(-1)).toBe('signed-out');
  });
});

describe('integrity: failed decrypt or network error never wipes the cache', () => {
  it('skips a tampered or transplanted document, keeps the cached copy, flags an integrity error, and keeps going', async () => {
    const s = new FakeServer();
    const a = await account(s);
    const col = brews(a.db, a.uid);
    await col.doc('good').set({ createdAt: '1', note: 'original' });
    await col.doc('other').set({ createdAt: '2' });
    await a.d.sync.syncNow();
    // the server (or an attacker) rewrites "good" with the ciphertext of a different document, and corrupts "other"
    const transplanted = s.stored(a.email, 'brews', 'other')!.data;
    const corrupted = { ...transplanted, ct: C.b64u(new Uint8Array(40)) };
    s.rawPut(a.email, 'brews', 'good', transplanted);
    s.rawPut(a.email, 'brews', 'other', corrupted);
    // a healthy new doc arrives in the same page
    const b = await second(s, a.email);
    await brews(b.db, b.uid).doc('fresh').set({ createdAt: '3' });
    await a.d.sync.syncNow();
    const now = await dump(a.d, a.uid, 'brews');
    expect(now.good).toEqual({ createdAt: '1', note: 'original' }); // untouched
    expect(now.other).toEqual({ createdAt: '2' });
    expect(now.fresh).toEqual({ createdAt: '3' });
    expect(a.d.sync.status()).toMatchObject({ state: 'error', error: { code: 'integrity' } });
    // and the next poll does not loop on the same bad rows
    const reqs = s.log.length;
    await a.d.sync.syncNow();
    expect(s.log.slice(reqs).filter(r => r.path.startsWith('/v1/sync')).length).toBe(1);
  });

  it('a fresh device that meets undecryptable rows simply does not show them', async () => {
    const s = new FakeServer();
    const a = await account(s);
    await brews(a.db, a.uid).doc('ok').set({ createdAt: '1' });
    s.rawPut(a.email, 'brews', 'junk', { v: 1, iv: C.b64u(new Uint8Array(12)), ct: C.b64u(new Uint8Array(32)) });
    const b = await second(s, a.email);
    expect(Object.keys(await dump(b.d, b.uid, 'brews'))).toEqual(['ok']);
  });

  it('network failures leave the cache and snapshots as they were', async () => {
    const s = new FakeServer();
    const a = await account(s);
    const col = brews(a.db, a.uid);
    await col.doc('keep').set({ createdAt: '1' });
    await a.d.sync.syncNow();
    s.failNext.push({ match: () => true, status: 500, code: 'internal', times: 3 });
    await a.d.sync.syncNow();
    expect(Object.keys(await dump(a.d, a.uid, 'brews'))).toEqual(['keep']);
  });

  it('never regresses a document to an older server copy', async () => {
    const s = new FakeServer();
    const a = await account(s);
    const p = a.db.doc(`data/users/${a.uid}/profile`);
    await p.set({ v: 2 });
    const hold = s.hold(r => r.path.startsWith('/v1/sync'));
    const stale = p.get(); // pull in flight, will return the state as of now
    await hold.reached;
    await p.set({ v: 3 });
    hold.release();
    await stale;
    await a.d.sync.syncNow();
    expect((await p.get()).data()).toEqual({ v: 3 });
  });
});

describe('races', () => {
  it('flushes are single-flight and preserve order', async () => {
    const s = new FakeServer();
    const a = await account(s);
    const col = brews(a.db, a.uid);
    const before = s.log.length;
    s.maxInFlight = 0;
    await Promise.all(Array.from({ length: 12 }, (_, i) => col.doc('d' + i).set({ createdAt: String(i) })));
    const puts = s.log.slice(before).filter(r => r.method === 'PUT').map(r => r.path.split('/').pop()!.split('?')[0]);
    expect(puts).toEqual(Array.from({ length: 12 }, (_, i) => 'd' + i));
    expect(s.maxInFlight).toBe(1);
  });

  it('coalesces repeated writes to one document into the latest value', async () => {
    const s = new FakeServer();
    const a = await account(s);
    const col = brews(a.db, a.uid);
    s.offline = true;
    await col.doc('c').set({ createdAt: '1', n: 1 }).catch(() => {});
    await col.doc('c').update({ n: 2 }).catch(() => {});
    await col.doc('c').update({ m: 3 }).catch(() => {});
    expect(a.d.sync.pendingWrites()).toBe(1);
    s.offline = false;
    await a.d.sync.syncNow();
    expect((await col.doc('c').get()).data()).toEqual({ createdAt: '1', n: 2, m: 3 });
    await col.doc('c').delete();
    await col.doc('c').set({ createdAt: '9' });
    expect((await col.doc('c').get()).data()).toEqual({ createdAt: '9' });
  });

  it('a pull that was in flight when you logged out is discarded', async () => {
    const s = new FakeServer();
    const a = await account(s);
    await brews(a.db, a.uid).doc('a-only').set({ createdAt: '1' });
    const hold = s.hold(r => r.path.startsWith('/v1/sync'));
    const inflight = (async () => { await a.d.sync.syncNow(); })();
    await hold.reached;
    const out = a.d.sync.auth.logout();
    hold.release();
    await Promise.all([inflight, out]);
    // a different account signs in on the same device: nothing of the first account may appear
    const email2 = 'second-account@example.com';
    await makeDevice(s).sync.auth.signup(email2, PW);
    const u2 = await a.d.sync.auth.login(email2, PW);
    const snap = await brews(await a.d.sync.use('db'), u2.id).get();
    expect(snap.size).toBe(0);
    expect(Object.keys(JSON.parse(a.d.kv.m.get(`bloomsync:cache:${u2.id}`) || '{"docs":{}}').docs)).toEqual([]);
  });

  it('a request that returns after the identity changed is ignored (stale generation)', async () => {
    const s = new FakeServer();
    const a = await account(s);
    const col = brews(a.db, a.uid);
    await col.doc('x').set({ createdAt: '1' });
    s.offline = true;
    await col.doc('y').set({ createdAt: '2' }).catch(() => {});
    s.offline = false;
    const hold = s.hold(r => r.method === 'PUT' && r.path.includes('/brews/y'));
    const flushing = a.d.sync.syncNow();
    await hold.reached;
    s.sessions.clear();
    hold.release();
    await flushing;
    await idle();
    expect(a.d.sync.isActive()).toBe(false);
    expect(a.d.sync.pendingWrites()).toBe(0); // signed out: no uid, nothing counted
    expect(JSON.parse(a.d.kv.m.get('bloomsync:queue')!).length).toBe(1); // but the write is kept for the next sign-in
  });

  it('a second pull request during a pull gets a trailing pass that includes late changes', async () => {
    const s = new FakeServer();
    const a = await account(s);
    const b = await second(s, a.email);
    const hold = s.hold(r => r.path.startsWith('/v1/sync'));
    const first = a.d.sync.syncNow();
    await hold.reached;
    await brews(b.db, b.uid).doc('late').set({ createdAt: '5' });
    const second2 = a.d.sync.syncNow();
    hold.release();
    await Promise.all([first, second2]);
    expect(Object.keys(await dump(a.d, a.uid, 'brews'))).toContain('late');
    expect(s.log.filter(r => r.path.startsWith('/v1/sync') && r.headers.Authorization === s.log.find(x => x.path.startsWith('/v1/sync'))!.headers.Authorization).length).toBeGreaterThanOrEqual(2);
  });

  it('paginates pulls until hasMore is false', async () => {
    const s = new FakeServer();
    const a = await account(s);
    for (let i = 0; i < 5; i++) await brews(a.db, a.uid).doc('p' + i).set({ createdAt: String(i) });
    const b = await second(s, a.email);
    s.pageCap = 2;
    const before = s.log.length;
    expect(Object.keys(await dump(b.d, b.uid, 'brews')).length).toBe(5);
    expect(s.log.slice(before).filter(r => r.path.startsWith('/v1/sync')).length).toBeGreaterThanOrEqual(2);
  });
});

describe('polling and lifecycle (fake clock)', () => {
  it('a second device sees changes and deletions by polling; hidden pages do not poll; unsubscribe stops polling', async () => {
    const s = new FakeServer();
    const a = await account(s, { pollMs: 1000 });
    const b = await second(s, a.email, { pollMs: 1000 });
    const colA = brews(a.db, a.uid), colB = brews(b.db, b.uid);
    let seenB: string[] = [];
    const unsub = colB.orderBy('createdAt', 'desc').limit(10).onSnapshot((x: any) => { seenB = ids(x); });
    await until(() => b.d.clock.pendingTimers > 0, 'poll timer');
    await colA.doc('r1').set({ createdAt: '1' });
    await colA.doc('r2').set({ createdAt: '2' });
    await b.d.clock.advance(1000);
    await until(() => seenB.join() === 'r2,r1', 'polled');
    await colA.doc('r1').delete();
    b.d.life.visible = false;
    await b.d.clock.advance(3000);
    expect(seenB.join()).toBe('r2,r1'); // hidden: no poll
    b.d.life.visible = true;
    b.d.life.fireVisible();
    await until(() => seenB.join() === 'r2', 'refresh on visible');
    unsub();
    const reqs = s.log.length;
    await b.d.clock.advance(5000);
    expect(s.log.length).toBe(reqs);
  });

  it('destroy() unsubscribes lifecycle handlers and timers', async () => {
    const s = new FakeServer();
    const a = await account(s);
    brews(a.db, a.uid).onSnapshot(() => {});
    await until(() => a.d.clock.pendingTimers > 0, 'timer');
    a.d.sync.destroy();
    expect(a.d.life.online.size + a.d.life.vis.size + a.d.life.hide.size).toBe(0);
    expect(a.d.clock.pendingTimers).toBe(0);
  });

  it('request timeouts surface as unavailable and abort the request', async () => {
    const s = new FakeServer();
    const a = await account(s);
    a.d.sync.configure({ timeoutMs: 500 });
    s.hold(r => r.path.startsWith('/v1/sync')); // never released
    const p = a.d.sync.syncNow();
    await idle();
    await a.d.clock.advance(600);
    await p;
    expect(a.d.sync.status().state).toBe('offline');
  });
});

describe('shots', () => {
  it('uploads ciphertext only and round-trips; tampering and id swaps are detected', async () => {
    const s = new FakeServer();
    const a = await account(s);
    const slog = Uint8Array.from({ length: 3000 }, (_, i) => (i * 7) & 255);
    await a.d.sync.shots.put('gm-1', '42', slog);
    await a.d.sync.shots.put('gm-1', '43', slog);
    const wire = s.user(a.email).shots.get('gm-1/42')!;
    expect(wire.length).toBe(slog.length + 32);
    expect(Buffer.from(wire).includes(Buffer.from(slog.subarray(100, 140)))).toBe(false);
    expect(await a.d.sync.shots.get('gm-1', '42')).toEqual(slog);
    expect((await a.d.sync.shots.list()).map(x => x.shotId).sort()).toEqual(['42', '43']);
    expect((await a.d.sync.shots.list({ machineId: 'gm-1', limit: 5 })).length).toBe(2);
    s.user(a.email).shots.set('gm-1/43', s.user(a.email).shots.get('gm-1/42')!); // swapped ciphertext
    await expect(a.d.sync.shots.get('gm-1', '43')).rejects.toMatchObject({ code: 'decrypt_failed' });
    const t = wire.slice(); t[20] ^= 1; s.user(a.email).shots.set('gm-1/42', t);
    await expect(a.d.sync.shots.get('gm-1', '42')).rejects.toMatchObject({ code: 'decrypt_failed' });
    await a.d.sync.shots.remove('gm-1', '42');
    await expect(a.d.sync.shots.get('gm-1', '42')).rejects.toMatchObject({ status: 404 });
  });
  it('requires sign-in (and unlock for put/get)', async () => {
    const d = makeDevice(new FakeServer());
    await expect(d.sync.shots.put('m', '1', new Uint8Array(3))).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(d.sync.shots.get('m', '1')).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(d.sync.shots.list()).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(d.sync.shots.remove('m', '1')).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});

describe('planUpload (first sign-in merge rule)', () => {
  const r = (id: string, createdAt: string, updatedAt?: string) => ({ id, createdAt, updatedAt });
  it('uploads what the account lacks and what is strictly newer; never drops local records', () => {
    const local = [r('a', '2026-01-01'), r('b', '2026-01-02', '2026-03-01'), r('c', '2026-01-03', '2026-01-03'), r('d', '2026-01-04'), r('e', '2026-01-05')];
    const remote = [r('b', '2026-01-02', '2026-02-01'), r('c', '2026-01-03', '2026-01-03'), r('d', '2026-01-04', '2026-05-01'), r('zz', '2025-01-01')];
    const plan = planUpload(local, remote);
    expect(plan.upload.map(x => x.id)).toEqual(['a', 'b', 'e']);
    expect(plan.keepRemote).toBe(2);
  });
  it('falls back to createdAt, ignores malformed and duplicate local entries', () => {
    const plan = planUpload([r('a', '2'), r('a', '9'), { id: '' } as any, null as any, { id: 'n' } as any], [r('a', '1'), null as any]);
    expect(plan.upload.map(x => x.id)).toEqual(['a', 'n']);
    expect(planUpload([], [r('x', '1')]).upload).toEqual([]);
    expect(planUpload([{ id: 'u', updatedAt: 5 } as any], [{ id: 'u', createdAt: '1' }]).upload.map(x => x.id)).toEqual([]);
  });
});

describe('misc', () => {
  it('configure() updates options and restarts polling; _reset reloads from storage', async () => {
    const s = new FakeServer();
    const a = await account(s, { pollMs: 1000 });
    const col = brews(a.db, a.uid);
    col.onSnapshot(() => {});
    await until(() => a.d.clock.pendingTimers > 0, 'poll');
    a.d.sync.configure({ pollMs: 2000, timeoutMs: 1000 });
    await a.d.sync.configure({}).ready;
    await col.doc('z').set({ createdAt: '1' });
    await a.d.sync.syncNow();
    a.d.clock.t += 500;
    await a.d.sync._reset();
    expect(a.d.sync.isActive()).toBe(true);
    expect(a.d.sync.auth.isUnlocked()).toBe(true);
    expect(cryptoImpl).toBeTruthy();
  });
});
