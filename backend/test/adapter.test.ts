/**
 * Drives the BUILT browser bundle (web/bloom-sync.js, from packages/sync) through the same call patterns Bloom's Store
 * uses, against the real Worker + local D1, with real WebCrypto. Run `npm run build` in packages/sync first.
 * Offline is simulated by making the injected fetch throw. PBKDF2 runs at 1000 rounds here because workerd caps it at
 * 100k (production uses 600k in the browser); the server floor is lowered to match via the MIN_KDF_ITERATIONS binding.
 */
import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
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
const wire: { method: string; url: string; body: unknown }[] = [];
const netFetch = (url: string, init: any) => {
  if (offline) return Promise.reject(new TypeError('offline'));
  wire.push({ method: init.method, url, body: init.body });
  // each request comes from a fresh IP so the auth rate limiter (8 per IP) does not trip across test steps
  return SELF.fetch(url, { ...init, headers: { ...init.headers, 'CF-Connecting-IP': `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` } });
};
/** Stands in for IndexedDB ("stay signed in"): keeps the non-extractable key across BS._reset(). */
const keys = new Map<string, CryptoKey>();
const keyStore = {
  save: async (u: string, k: CryptoKey) => void keys.set(u, k),
  load: async (u: string) => keys.get(u) ?? null,
  clear: async (u: string) => void keys.delete(u)
};

let BS: any;
const PW = 'a long password';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 4000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(10); } };

async function signedInFacade() {
  const u = await BS.auth.signup(`${uniq('ad')}@example.com`, PW, 'Tester');
  const [db, user] = await Promise.all([BS.use('db'), BS.use('user')]);
  const id = await user.id();
  expect(id).toBe(u.id);
  return { db, user, uid: id as string, email: BS.auth.current().email as string, recoveryKey: u.recoveryKey as string };
}

beforeAll(async () => {
  await import('../../web/bloom-sync.js');
  BS = g.BloomSync;
  expect(BS).toBeTruthy();
});
beforeEach(async () => {
  offline = false;
  wire.length = 0;
  store.clear(); keys.clear();
  await BS._reset();
  BS.configure({ baseUrl: 'http://bloom.test', pollMs: 50, fetch: netFetch, keyStore, kdfIterations: 1000, minKdfIterations: 1000 });
});

describe('BloomSync browser bundle (Bloom call patterns)', () => {
  it('exposes the documented public API', () => {
    for (const k of ['configure', 'auth', 'use', 'isActive', 'pendingWrites', 'syncNow', 'status', 'shots', 'planUpload', 'ready'])
      expect(BS[k], k).toBeDefined();
    for (const k of ['signup', 'login', 'logout', 'unlock', 'recover', 'changePassword', 'current', 'isSignedIn', 'isUnlocked', 'state'])
      expect(typeof BS.auth[k], k).toBe('function');
    expect(BS.supported).toBe(true);
  });

  it('user.id() is null when signed out, backend id after signup, null after logout; login works and a wrong password fails', async () => {
    const user = await BS.use('user');
    expect(await user.id()).toBeNull();
    const email = `${uniq('ad')}@example.com`;
    const u = await BS.auth.signup(email, PW, 'T');
    expect(u.recoveryKey).toMatch(/^([A-Z2-7]{4}-){13}[A-Z2-7]{4}$/);
    expect(await user.id()).toBe(u.id);
    expect(BS.auth.current().name).toBe('T');
    expect(BS.isActive()).toBe(true);
    await BS.auth.logout();
    expect(await user.id()).toBeNull();
    expect(BS.isActive()).toBe(false);
    const back = await BS.auth.login(email, PW);
    expect(back.id).toBe(u.id);
    await BS.auth.logout();
    const bad = await BS.auth.login(email, 'wrong password!').catch((e: any) => e);
    expect(bad.code).toBe('invalid_credentials');
  });

  it('profile/settings docs: get() -> data(), set(), update(), delete(); update on a missing doc rejects', async () => {
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
    await expect(db.doc('data/users/' + uid + '/nothing').update({ a: 1 })).rejects.toBeTruthy();
    await setDoc.delete();
    expect((await setDoc.get()).exists).toBe(false);
  });

  it('brews: orderBy(createdAt,desc).limit(n).onSnapshot with set/update/delete', async () => {
    const { db, uid } = await signedInFacade();
    const col = db.doc('data/users/' + uid + '/profile').collection('brews');
    const snaps: any[] = [];
    const unsub = col.orderBy('createdAt', 'desc').limit(2).onSnapshot((s: any) => snaps.push(s.docs.map((d: any) => Object.assign({ id: d.id }, d.data()))), () => { throw new Error('err cb'); });
    await until(() => snaps.length >= 1);
    expect(snaps[0]).toEqual([]);
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
    expect(snaps.length).toBe(n);
    expect(BS.pendingWrites()).toBe(0);
  });

  it('what reaches the server and D1 is ciphertext only: no plaintext, password or recovery key anywhere', async () => {
    const { db, uid, email, recoveryKey } = await signedInFacade();
    const col = db.doc('data/users/' + uid + '/profile').collection('brews');
    await col.doc('b1').set({ createdAt: '2026-01-01', note: 'zz-distinctive-note-zz', dose: 18 });
    await db.doc('data/users/' + uid + '/profile').set({ name: 'Zed Secretname' });
    await BS.syncNow();
    const rows = (await env.DB.prepare('SELECT collection,id,data FROM docs WHERE user_id=?').bind(uid).all<any>()).results;
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(Object.keys(JSON.parse(r.data)).sort()).toEqual(['ct', 'iv', 'v']);
      expect(r.data).not.toContain('distinctive');
      expect(r.data).not.toContain('Secretname');
    }
    const user = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(uid).first<any>();
    const all = JSON.stringify([rows, user, wire.map(w => [w.method, w.url, typeof w.body === 'string' ? w.body : ''])]);
    for (const secret of [PW, recoveryKey, recoveryKey.replace(/-/g, ''), 'zz-distinctive-note-zz', 'Secretname']) expect(all).not.toContain(secret);
    expect(email).toBeTruthy();
  });

  it('a second device signs in with the password only and sees data, changes and deletions by polling', async () => {
    const a = await signedInFacade();
    const colA = a.db.doc('data/users/' + a.uid + '/profile').collection('brews');
    await colA.doc('r1').set({ createdAt: '1', v: 1 });
    await colA.doc('r2').set({ createdAt: '2', v: 1 });
    await BS.syncNow();
    const sess = JSON.parse(store.get('bloomsync:session')!);
    // "device B": fresh storage and memory, signs in with the password
    store.clear(); keys.clear(); await BS._reset();
    await BS.auth.login(a.email, PW);
    const db = await BS.use('db');
    const col = db.doc('data/users/' + a.uid + '/profile').collection('brews');
    let ids: string[] = [];
    const unsub = col.orderBy('createdAt', 'desc').limit(10).onSnapshot((s: any) => { ids = s.docs.map((d: any) => d.id); });
    await until(() => ids.length === 2);
    // device A's session (raw API: it has no key, so write something B must treat as undecryptable and ignore)
    const h = { Authorization: 'Bearer ' + sess.token, 'Content-Type': 'application/json' };
    await SELF.fetch('http://bloom.test/v1/docs/brews/r1', { method: 'DELETE', headers: h });
    await until(() => ids.join() === 'r2');
    unsub();
  });

  it('offline: writes queue in storage, snapshots/reads use the cache, and flush when back online', async () => {
    const { db, uid } = await signedInFacade();
    const col = db.doc('data/users/' + uid + '/profile').collection('brews');
    let ids: string[] = [];
    const unsub = col.orderBy('createdAt', 'desc').limit(10).onSnapshot((s: any) => { ids = s.docs.map((d: any) => d.id); });
    await col.doc('on1').set({ createdAt: '1' });
    await until(() => ids.length === 1);

    offline = true;
    await expect(col.doc('off1').set({ createdAt: '2' })).rejects.toMatchObject({ code: 'unavailable' });
    await col.doc('off1').set({ createdAt: '2' }).catch(() => {});
    await until(() => ids.join() === 'off1,on1');
    expect(BS.pendingWrites()).toBe(1);
    expect(JSON.parse(store.get('bloomsync:queue')!)).toHaveLength(1);
    expect(BS.status().state).toBe('offline');
    const snap = await col.get();
    expect(snap.docs.map((d: any) => d.id).sort()).toEqual(['off1', 'on1']);

    // a fresh page load while offline: nothing in memory; queue, cache and the stay-signed-in key restored from storage
    await BS._reset();
    expect(BS.pendingWrites()).toBe(1);
    expect(BS.isActive()).toBe(true);
    let cached: string[] = [];
    const unsub2 = (await BS.use('db')).doc('data/users/' + uid + '/profile').collection('brews').orderBy('createdAt', 'desc').limit(10)
      .onSnapshot((s: any) => { cached = s.docs.map((d: any) => d.id); }, () => { throw new Error('should fall back to cache'); });
    await until(() => cached.length > 0);
    expect(cached).toContain('on1');

    offline = false;
    await BS.syncNow();
    await until(() => BS.pendingWrites() === 0, 5000);
    const token = JSON.parse(store.get('bloomsync:session')!).token;
    const raw = await SELF.fetch('http://bloom.test/v1/docs/brews/off1', { headers: { Authorization: 'Bearer ' + token } });
    expect(raw.status).toBe(200);
    unsub(); unsub2();
  });

  it('first snapshot offline with no synced cache calls the error callback (Bloom falls back to local)', async () => {
    const { db, uid } = await signedInFacade();
    store.delete('bloomsync:cache:' + uid); await BS._reset();
    offline = true;
    const err = await new Promise<any>(res => {
      (db.doc('data/users/' + uid + '/profile').collection('brews')).orderBy('createdAt', 'desc').limit(5).onSnapshot(() => res(null), (e: any) => res(e));
    });
    expect(err).toBeTruthy();
  });

  it('without a stored key the session is locked after a reload; unlock restores it. Wrong user paths are refused', async () => {
    const { db, uid, email } = await signedInFacade();
    await expect(db.doc('data/users/someone-else/profile').get()).rejects.toMatchObject({ code: 'permission-denied' });
    await db.doc('data/users/' + uid + '/profile').set({ name: 'Keep' });
    keys.clear();
    await BS._reset();
    expect(BS.auth.state()).toBe('locked');
    expect(BS.isActive()).toBe(false);
    await expect(BS.auth.unlock('wrong password!')).rejects.toMatchObject({ code: 'invalid_credentials' });
    await BS.auth.unlock(PW);
    expect(BS.isActive()).toBe(true);
    const d2 = await BS.use('db');
    expect((await d2.doc('data/users/' + uid + '/profile').get()).data()).toEqual({ name: 'Keep' });
    await BS.auth.logout();
    expect(store.get('bloomsync:session')).toBeUndefined();
    await BS.auth.login(email, PW);
    expect((await (await BS.use('db')).doc('data/users/' + uid + '/profile').get()).data()).toEqual({ name: 'Keep' });
  });

  it('recovery key and change-password work end to end against the real server', async () => {
    const a = await signedInFacade();
    await a.db.doc('data/users/' + a.uid + '/profile').set({ name: 'Survivor' });
    await BS.syncNow();
    await BS.auth.changePassword(PW, 'second password!');
    await BS.auth.logout();
    await expect(BS.auth.login(a.email, PW)).rejects.toMatchObject({ code: 'invalid_credentials' });
    await BS.auth.login(a.email, 'second password!');
    await BS.auth.logout();
    await BS.auth.recover(a.email, a.recoveryKey, 'third password!!');
    expect((await (await BS.use('db')).doc('data/users/' + a.uid + '/profile').get()).data()).toEqual({ name: 'Survivor' });
    await BS.auth.logout();
    await BS.auth.login(a.email, 'third password!!');
  });

  it('shots: encrypted upload/download round trip and the server refuses plaintext', async () => {
    const { uid } = await signedInFacade();
    const slog = Uint8Array.from({ length: 4000 }, (_, i) => (i * 13) & 255);
    await BS.shots.put('gm-1', '42', slog);
    expect(await BS.shots.get('gm-1', '42')).toEqual(slog);
    const list = await BS.shots.list();
    expect(list).toMatchObject([{ machineId: 'gm-1', shotId: '42', size: slog.length + 32 }]);
    const row = await env.DB.prepare('SELECT data FROM shots WHERE user_id=?').bind(uid).first<{ data: ArrayBuffer }>();
    const hay = new Uint8Array(row!.data).reduce((a, b) => a + String.fromCharCode(b), '');
    expect(hay.includes(String.fromCharCode(...slog.subarray(500, 540)))).toBe(false);
    const token = JSON.parse(store.get('bloomsync:session')!).token;
    const plain = await SELF.fetch('http://bloom.test/v1/shots/gm-1/43', { method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream' }, body: slog });
    expect(plain.status).toBe(422);
    await BS.shots.remove('gm-1', '42');
  });
});
