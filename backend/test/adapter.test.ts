/**
 * Drives web/bloom-sync.js through the same call patterns Bloom's Store uses (index.html ~1595-1700 and ~4415-4445),
 * against the real Worker + local D1. Offline is simulated by making the injected fetch throw.
 */
import { SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { uniq } from './helpers';

const store = new Map<string, string>();
const g = globalThis as any;
g.window = g;
g.localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; }
};

let offline = false;
const netFetch = (url: string, init: RequestInit) => {
  if (offline) return Promise.reject(new TypeError('offline'));
  return SELF.fetch(url, init);
};

let BS: any;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(10); } };

async function signedInFacade() {
  const u = await BS.auth.signup(`${uniq('ad')}@example.com`, 'a long password', 'Tester');
  const [db, user] = await Promise.all([BS.use('db'), BS.use('user')]);
  const id = await user.id();
  expect(id).toBe(u.id);
  return { db, user, uid: id as string };
}

beforeAll(async () => {
  await import(/* @vite-ignore */ '../../web/bloom-sync.js' as string);
  BS = g.BloomSync;
  expect(BS).toBeTruthy();
});
beforeEach(() => {
  offline = false;
  store.clear();
  BS._reset();
  BS.configure({ baseUrl: 'http://bloom.test', pollMs: 50, fetch: netFetch });
});

describe('BloomSync facade (Bloom call patterns)', () => {
  it('user.id() is null when signed out, backend id after signup, null after logout', async () => {
    const user = await BS.use('user');
    expect(await user.id()).toBeNull();
    const email = `${uniq('ad')}@example.com`;
    const u = await BS.auth.signup(email, 'a long password', 'T');
    expect(await user.id()).toBe(u.id);
    expect(BS.auth.current().name).toBe('T');
    await BS.auth.logout();
    expect(await user.id()).toBeNull();
    const back = await BS.auth.login(email, 'a long password');
    expect(back.id).toBe(u.id);
    const bad = await BS.auth.login(email, 'wrong password!').catch((e: any) => e);
    expect(bad.code).toBe('invalid_credentials');
  });

  it('profile/settings docs: get() -> data(), set(), update(), delete()', async () => {
    const { db, uid } = await signedInFacade();
    const profile = db.doc('data/users/' + uid + '/profile');
    const setDoc = db.doc('data/users/' + uid + '/settings');
    let snap = await profile.get();
    expect(snap.exists).toBe(false);
    expect(snap.data()).toBeUndefined();
    await profile.set({ name: 'Brad', bagsMigrated: false, updatedAt: 'x' });
    snap = await profile.get();
    expect(snap.data()).toEqual({ name: 'Brad', bagsMigrated: false, updatedAt: 'x' });
    await profile.update({ bagsMigrated: true });
    expect((await profile.get()).data().bagsMigrated).toBe(true);
    await setDoc.set({ grinders: [{ id: 'g1' }], schema: 1, updatedAt: '2026-01-01' });
    expect((await setDoc.get()).data().grinders).toHaveLength(1);
    // update on a missing doc rejects (Bloom falls back to set() in markBagsMigrated)
    await expect(db.doc('data/users/' + uid + '/nothing').update({ a: 1 })).rejects.toBeTruthy();
    await setDoc.delete();
    expect((await setDoc.get()).exists).toBe(false);
  });

  it('brews: orderBy(createdAt,desc).limit(n).onSnapshot with set/update/delete', async () => {
    const { db, uid } = await signedInFacade();
    const profile = db.doc('data/users/' + uid + '/profile');
    const col = profile.collection('brews');
    const snaps: any[] = [];
    const unsub = col.orderBy('createdAt', 'desc').limit(2).onSnapshot((s: any) => snaps.push(s.docs.map((d: any) => Object.assign({ id: d.id }, d.data()))), () => { throw new Error('err cb'); });
    await until(() => snaps.length >= 1);
    expect(snaps[0]).toEqual([]); // first snapshot: server state, empty account
    await col.doc('b1').set({ createdAt: '2026-01-01', dose: 18 });
    await col.doc('b2').set({ createdAt: '2026-01-02', dose: 19 });
    await col.doc('b3').set({ createdAt: '2026-01-03', dose: 20 });
    await until(() => JSON.stringify(snaps[snaps.length - 1].map((d: any) => d.id)) === '["b3","b2"]');
    await col.doc('b3').update({ dose: 21 });
    await until(() => snaps[snaps.length - 1][0].dose === 21);
    await col.doc('b3').delete();
    await until(() => JSON.stringify(snaps[snaps.length - 1].map((d: any) => d.id)) === '["b2","b1"]');
    unsub();
    const n = snaps.length;
    await col.doc('b9').set({ createdAt: '2026-02-01' });
    await sleep(150);
    expect(snaps.length).toBe(n); // no callbacks after unsubscribe
    expect(BS.pendingWrites()).toBe(0);
  });

  it('bags: collection-level onSnapshot without orderBy', async () => {
    const { db, uid } = await signedInFacade();
    const bagCol = db.doc('data/users/' + uid + '/profile').collection('bags');
    let last: any[] = [];
    const unsub = bagCol.onSnapshot((s: any) => { last = s.docs.map((d: any) => Object.assign({ id: d.id }, d.data())); });
    await bagCol.doc('x').set({ status: 'open' });
    await bagCol.doc('y').set({ status: 'finished' });
    await until(() => last.length === 2);
    expect(last.map(d => d.id)).toEqual(['x', 'y']);
    unsub();
  });

  it('a second device sees changes and deletions by polling (cursor + tombstones)', async () => {
    const a = await signedInFacade();
    const colA = a.db.doc('data/users/' + a.uid + '/profile').collection('brews');
    await colA.doc('r1').set({ createdAt: '1', v: 1 });
    await colA.doc('r2').set({ createdAt: '2', v: 1 });
    await BS.syncNow();
    const sess = JSON.parse(store.get('bloomsync:session')!);
    // "device B": same account, fresh storage and memory
    store.clear(); BS._reset();
    store.set('bloomsync:session', JSON.stringify(sess));
    BS._reset();
    const db = await BS.use('db');
    const col = db.doc('data/users/' + a.uid + '/profile').collection('brews');
    let ids: string[] = [];
    const unsub = col.orderBy('createdAt', 'desc').limit(10).onSnapshot((s: any) => { ids = s.docs.map((d: any) => d.id); });
    await until(() => ids.length === 2);
    // device A deletes r1 and adds r3 (go through raw API with the same token)
    const h = { Authorization: 'Bearer ' + sess.token, 'Content-Type': 'application/json' };
    await SELF.fetch('http://bloom.test/v1/docs/brews/r1', { method: 'DELETE', headers: h });
    await SELF.fetch('http://bloom.test/v1/docs/brews/r3', { method: 'PUT', headers: h, body: JSON.stringify({ createdAt: '3' }) });
    await until(() => ids.join() === 'r3,r2');
    unsub();
  });

  it('offline: writes queue in localStorage, snapshots/reads use the cache, and flush when back online', async () => {
    const { db, uid } = await signedInFacade();
    const col = db.doc('data/users/' + uid + '/profile').collection('brews');
    let ids: string[] = [];
    const unsub = col.orderBy('createdAt', 'desc').limit(10).onSnapshot((s: any) => { ids = s.docs.map((d: any) => d.id); });
    await col.doc('on1').set({ createdAt: '1' });
    await until(() => ids.length === 1);

    offline = true;
    await expect(col.doc('off1').set({ createdAt: '2' })).rejects.toMatchObject({ code: 'unavailable' });
    await col.doc('off1').set({ createdAt: '2' }).catch(() => {}); // Bloom's retry: coalesced, not duplicated
    await until(() => ids.join() === 'off1,on1'); // optimistic local snapshot
    expect(BS.pendingWrites()).toBe(1);
    expect(JSON.parse(store.get('bloomsync:queue')!)).toHaveLength(1);
    const snap = await col.get(); // pull fails offline, cache answers
    expect(snap.docs.map((d: any) => d.id).sort()).toEqual(['off1', 'on1']);

    // a fresh page load while offline: nothing in memory, queue + cache restored from storage
    BS._reset();
    expect(BS.pendingWrites()).toBe(1);
    let cached: string[] = [];
    const unsub2 = (await BS.use('db')).doc('data/users/' + uid + '/profile').collection('brews').orderBy('createdAt', 'desc').limit(10)
      .onSnapshot((s: any) => { cached = s.docs.map((d: any) => d.id); }, () => { throw new Error('should fall back to cache'); });
    await until(() => cached.length > 0);
    expect(cached).toContain('on1');

    offline = false;
    await BS.syncNow();
    await until(() => BS.pendingWrites() === 0, 5000);
    const raw = await SELF.fetch('http://bloom.test/v1/docs/brews/off1', { headers: { Authorization: 'Bearer ' + JSON.parse(store.get('bloomsync:session')!).token } });
    expect(raw.status).toBe(200);
    unsub(); unsub2();
  });

  it('first snapshot offline with no synced cache calls the error callback (Bloom falls back to local)', async () => {
    const { db, uid } = await signedInFacade();
    store.delete('bloomsync:cache:' + uid); BS._reset();
    offline = true;
    const err = await new Promise<any>(res => {
      (db.doc('data/users/' + uid + '/profile').collection('brews')).orderBy('createdAt', 'desc').limit(5).onSnapshot(() => res(null), (e: any) => res(e));
    });
    expect(err).toBeTruthy();
  });

  it('rejects paths for another user and works with the same shapes after re-login', async () => {
    const { db, uid } = await signedInFacade();
    await expect(db.doc('data/users/someone-else/profile').get()).rejects.toMatchObject({ code: 'permission-denied' });
    await db.doc('data/users/' + uid + '/profile').set({ name: 'Keep' });
    const email = BS.auth.current().email;
    await BS.auth.logout();
    expect(store.get('bloomsync:session')).toBeUndefined();
    await BS.auth.login(email, 'a long password');
    const d2 = await BS.use('db');
    expect((await d2.doc('data/users/' + uid + '/profile').get()).data()).toEqual({ name: 'Keep' });
  });
});
