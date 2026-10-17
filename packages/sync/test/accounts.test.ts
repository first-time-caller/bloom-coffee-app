import { describe, expect, it } from 'vitest';
import * as C from '../src/crypto.ts';
import { FakeServer, cryptoImpl, findLeak, makeDevice, spyCrypto, until } from './harness.ts';

const PW = 'correct horse battery';
const mail = (() => { let n = 0; return () => `user${++n}@Example.com`; })();

async function account(server: FakeServer, over: Parameters<typeof makeDevice>[1] = {}, email = mail()) {
  const d = makeDevice(server, over);
  const u = await d.sync.auth.signup(email, PW, 'Tester');
  return { d, u, email: email.toLowerCase() };
}

describe('signup and login', () => {
  it('signs up, returns a recovery key once, and stores only wrapped keys server-side', async () => {
    const s = new FakeServer();
    const { d, u, email } = await account(s);
    expect(u.recoveryKey).toMatch(/^([A-Z2-7]{4}-){13}[A-Z2-7]{4}$/);
    expect(d.sync.auth.current()).toEqual({ id: u.id, email, name: 'Tester' });
    expect(d.sync.isActive()).toBe(true);
    expect(d.sync.auth.state()).toBe('ready');
    const rec = s.user(email);
    expect(rec.wrappedDek).toMatchObject({ v: 1 });
    expect(rec.recoveryWrappedDek).toMatchObject({ v: 1 });
    expect(rec.kdf).toMatchObject({ alg: 'pbkdf2-sha256', iterations: 1000 });
    // the recovery key is not retrievable afterwards
    expect(JSON.stringify(d.sync.auth.current())).not.toContain(u.recoveryKey);
    expect(JSON.stringify([...d.kv.m.values()])).not.toContain(u.recoveryKey);
  });

  it('validates the password locally and requires a configured base URL', async () => {
    const s = new FakeServer();
    const d = makeDevice(s);
    await expect(d.sync.auth.signup('a@b.co', 'short')).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(d.sync.auth.recover('a@b.co', 'x', 'short')).rejects.toMatchObject({ code: 'validation_failed' });
    d.sync.configure({ baseUrl: '' });
    await expect(d.sync.auth.login('a@b.co', PW)).rejects.toMatchObject({ code: 'unconfigured' });
    expect(d.sync.isConfigured()).toBe(false);
  });

  it('logs in on a second device with the right password; email case and spacing do not matter', async () => {
    const s = new FakeServer();
    const { u, email } = await account(s);
    const b = makeDevice(s);
    const who = await b.sync.auth.login('  ' + email.toUpperCase() + ' ', PW);
    expect(who.id).toBe(u.id);
    expect(b.sync.isActive()).toBe(true);
  });

  it('rejects a wrong password and an unknown email the same way, leaving no session behind', async () => {
    const s = new FakeServer();
    const { email } = await account(s);
    const b = makeDevice(s);
    await expect(b.sync.auth.login(email, 'wrong password!')).rejects.toMatchObject({ code: 'invalid_credentials' });
    await expect(b.sync.auth.login('nobody@example.com', PW)).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(b.sync.auth.isSignedIn()).toBe(false);
    expect(b.kv.m.has('bloomsync:session')).toBe(false);
  });

  it('refuses to derive keys when the server offers fewer rounds than the floor (downgrade attack)', async () => {
    const s = new FakeServer();
    const { email } = await account(s, { iterations: 5000 });
    s.user(email).kdf.iterations = 1; // malicious or buggy server
    const b = makeDevice(s, { minIterations: 5000 });
    await expect(b.sync.auth.login(email, PW)).rejects.toMatchObject({ code: 'bad_kdf' });
  });

  it('signs out again if the server hands back a data key that does not open', async () => {
    const s = new FakeServer();
    const { email } = await account(s);
    const good = s.user(email).wrappedDek;
    s.user(email).wrappedDek = { ...good, ct: C.b64u(new Uint8Array(48)) };
    const b = makeDevice(s);
    await expect(b.sync.auth.login(email, PW)).rejects.toMatchObject({ code: 'integrity' });
    expect(b.sync.auth.isSignedIn()).toBe(false);
    expect(s.sessions.size).toBe(1); // the failed device's session was revoked
  });

  it('serialises concurrent auth calls', async () => {
    const s = new FakeServer();
    const { email } = await account(s);
    const b = makeDevice(s);
    const [x, y] = await Promise.allSettled([b.sync.auth.login(email, 'wrong password!'), b.sync.auth.login(email, PW)]);
    expect(x.status).toBe('rejected');
    expect(y.status).toBe('fulfilled');
    expect(b.sync.isActive()).toBe(true);
  });
});

describe('stay signed in, lock and unlock', () => {
  it('restores the data key from the key store after a reload', async () => {
    const s = new FakeServer();
    const { d, u } = await account(s);
    d.sync.destroy();
    const again = makeDevice(s, { kv: d.kv, keys: d.keys });
    await again.sync.ready;
    expect(again.sync.isActive()).toBe(true);
    expect(again.sync.auth.current()!.id).toBe(u.id);
  });

  it('is locked after a reload when no key was kept, and unlock needs the right password', async () => {
    const s = new FakeServer();
    const { d } = await account(s, {}, mail());
    d.sync.destroy();
    const again = makeDevice(s, { kv: d.kv, keys: null });
    await again.sync.ready;
    expect(again.sync.auth.state()).toBe('locked');
    expect(again.sync.isActive()).toBe(false);
    expect(again.sync.status().state).toBe('locked');
    const db = await again.sync.use('db');
    await expect(db.doc('data/users/' + again.sync.auth.current()!.id + '/profile').set({ a: 1 })).rejects.toMatchObject({ code: 'locked' });
    await expect(again.sync.auth.unlock('wrong password!')).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(again.sync.auth.state()).toBe('locked');
    await again.sync.auth.unlock(PW);
    expect(again.sync.auth.state()).toBe('ready');
    expect(again.sync.isActive()).toBe(true);
    await again.sync.auth.unlock(PW); // no-op when already unlocked
  });

  it('staySignedIn:false never stores the key', async () => {
    const s = new FakeServer();
    const d = makeDevice(s);
    const u = await d.sync.auth.signup(mail(), PW, '', { staySignedIn: false });
    expect(d.keys.m.has(u.id)).toBe(false);
    d.sync.destroy();
    const again = makeDevice(s, { kv: d.kv, keys: d.keys });
    await again.sync.ready;
    expect(again.sync.auth.state()).toBe('locked');
    await again.sync.auth.unlock(PW, { staySignedIn: true });
    expect(again.keys.m.has(u.id)).toBe(true);
  });

  it('unlock without a session fails clearly', async () => {
    const d = makeDevice(new FakeServer());
    await expect(d.sync.auth.unlock(PW)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('logout clears the key, cache, queue and session', async () => {
    const s = new FakeServer();
    const { d, u } = await account(s);
    const db = await d.sync.use('db');
    await db.doc(`data/users/${u.id}/profile`).set({ name: 'x' });
    await d.sync.auth.logout();
    expect(d.sync.isActive()).toBe(false);
    expect(d.keys.m.size).toBe(0);
    expect([...d.kv.m.keys()].filter(k => k.startsWith('bloomsync:cache:') || k === 'bloomsync:session')).toEqual([]);
    expect(JSON.parse(d.kv.m.get('bloomsync:queue') || '[]')).toEqual([]);
    expect(d.sync.pendingWrites()).toBe(0);
    expect(s.sessions.size).toBe(0);
    await expect(db.doc(`data/users/${u.id}/profile`).get()).rejects.toMatchObject({ code: 'permission-denied' });
    await d.sync.auth.logout(); // idempotent
  });

  it('an expired session (401) drops to signed-out, keeps queued writes, and they flush after signing in again', async () => {
    const s = new FakeServer();
    const { d, u, email } = await account(s);
    const db = await d.sync.use('db');
    s.offline = true;
    await db.doc(`data/users/${u.id}/profile`).set({ name: 'offline write' }).catch(() => {});
    expect(d.sync.pendingWrites()).toBe(1);
    s.offline = false;
    s.sessions.clear(); // server expired the session
    await d.sync.syncNow();
    expect(d.sync.isActive()).toBe(false);
    expect(d.events.some(e => e.name === 'bloomsync:authchange' && e.detail.expired)).toBe(true);
    await d.sync.auth.login(email, PW);
    await until(() => !!s.stored(email, '_root', 'profile'), 'queued write to flush');
    expect(d.sync.pendingWrites()).toBe(0);
  });
});

describe('recovery', () => {
  it('recovers with the recovery key, sets a new password, keeps the data readable and revokes old sessions', async () => {
    const s = new FakeServer();
    const { d, u, email } = await account(s);
    const db = await d.sync.use('db');
    await db.doc(`data/users/${u.id}/profile`).set({ name: 'Brad', note: 'yz-unique-note' });
    await d.sync.syncNow();

    const b = makeDevice(s);
    const who = await b.sync.auth.recover(email.toUpperCase(), u.recoveryKey.toLowerCase(), 'brand new password');
    expect(who.id).toBe(u.id);
    const snap = await (await b.sync.use('db')).doc(`data/users/${u.id}/profile`).get();
    expect(snap.data()).toEqual({ name: 'Brad', note: 'yz-unique-note' });

    await expect(makeDevice(s).sync.auth.login(email, PW)).rejects.toMatchObject({ code: 'invalid_credentials' });
    await makeDevice(s).sync.auth.login(email, 'brand new password');
    await d.sync.syncNow();
    expect(d.sync.isActive()).toBe(false); // device A's session was revoked by the recovery
  });

  it('rejects a wrong or mistyped recovery key and a short new password', async () => {
    const s = new FakeServer();
    const { u, email } = await account(s);
    const b = makeDevice(s);
    const other = await C.encodeRecoveryKey(cryptoImpl, C.randomBytes(cryptoImpl, 32));
    await expect(b.sync.auth.recover(email, other, 'brand new password')).rejects.toMatchObject({ code: 'invalid_credentials' });
    const typo = (u.recoveryKey[0] === 'A' ? 'B' : 'A') + u.recoveryKey.slice(1);
    await expect(b.sync.auth.recover(email, typo, 'brand new password')).rejects.toMatchObject({ code: 'invalid_recovery_key' });
    await expect(b.sync.auth.recover(email, u.recoveryKey, 'short')).rejects.toMatchObject({ code: 'validation_failed' });
    expect(b.sync.auth.isSignedIn()).toBe(false);
  });

  it('a recovery wrap the server swapped for garbage is reported, not trusted', async () => {
    const s = new FakeServer();
    const { u, email } = await account(s);
    s.user(email).recoveryWrappedDek = { v: 1, iv: C.b64u(new Uint8Array(12)), ct: C.b64u(new Uint8Array(48)) };
    await expect(makeDevice(s).sync.auth.recover(email, u.recoveryKey, 'brand new password')).rejects.toMatchObject({ code: 'invalid_recovery_key' });
  });
});

describe('change password', () => {
  it('needs the current password, signs out other devices and keeps this one', async () => {
    const s = new FakeServer();
    const { d, u, email } = await account(s);
    const other = makeDevice(s);
    await other.sync.auth.login(email, PW);
    await expect(d.sync.auth.changePassword('not my password', 'another password')).rejects.toMatchObject({ code: 'invalid_credentials' });
    await expect(d.sync.auth.changePassword(PW, 'short')).rejects.toMatchObject({ code: 'validation_failed' });
    await d.sync.auth.changePassword(PW, 'another password');
    expect(d.sync.isActive()).toBe(true);
    await expect(makeDevice(s).sync.auth.login(email, PW)).rejects.toMatchObject({ code: 'invalid_credentials' });
    const c = makeDevice(s);
    await c.sync.auth.login(email, 'another password');
    // the data key is unchanged, so data written before is still readable
    const db = await d.sync.use('db');
    await db.doc(`data/users/${u.id}/profile`).set({ name: 'after' });
    await d.sync.syncNow();
    expect((await (await c.sync.use('db')).doc(`data/users/${u.id}/profile`).get()).data()).toEqual({ name: 'after' });
    await other.sync.syncNow();
    expect(other.sync.isActive()).toBe(false);
    // the recovery key still works
    await makeDevice(s).sync.auth.recover(email, u.recoveryKey, 'third password!!');
  });

  it('requires a signed-in account', async () => {
    const d = makeDevice(new FakeServer());
    await expect(d.sync.auth.changePassword('a', 'bbbbbbbbb')).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});

describe('what the server receives', () => {
  it('never sees the password, master key, kek, data key, recovery key or any plaintext', async () => {
    const s = new FakeServer();
    const spy = spyCrypto();
    const d = makeDevice(s, { crypto: spy.crypto });
    const email = 'leakcheck@example.com';
    const u = await d.sync.auth.signup(email, PW, 'Pat');
    const db = await d.sync.use('db');
    const profile = db.doc(`data/users/${u.id}/profile`);
    await profile.set({ name: 'Pat Secretname', bagsMigrated: false });
    await profile.update({ note: 'zz-distinctive-note-zz' });
    await profile.collection('brews').doc('b1').set({ createdAt: '2026-01-01', note: 'zz-brew-note-zz', dose: 18 });
    await d.sync.shots.put('gm-1', '7', new TextEncoder().encode('SLOG-PLAINTEXT-MARKER-0123456789'));
    await d.sync.syncNow();
    await d.sync.auth.changePassword(PW, 'second password!!');
    await d.sync.auth.logout();
    const e = makeDevice(s, { crypto: spy.crypto });
    await e.sync.auth.login(email, 'second password!!');
    await e.sync.auth.logout();
    const f = makeDevice(s, { crypto: spy.crypto });
    await f.sync.auth.recover(email, u.recoveryKey, 'third password!!');
    await f.sync.syncNow();

    expect(spy.secrets.length).toBeGreaterThan(8); // the spy really saw master keys, deks, recovery keys...
    const texts = [PW, 'second password!!', 'third password!!', u.recoveryKey, u.recoveryKey.replace(/-/g, ''), 'zz-distinctive-note-zz', 'zz-brew-note-zz', 'Secretname', 'SLOG-PLAINTEXT-MARKER'];
    expect(findLeak(s.log, spy.secrets, texts)).toBeNull();
    // and only the documented fields cross the wire
    const signup = JSON.parse(s.log.find(r => r.path === '/v1/auth/signup')!.bodyText!);
    expect(Object.keys(signup).sort()).toEqual(['authKey', 'email', 'kdf', 'name', 'recoveryAuth', 'recoveryWrappedDek', 'wrappedDek']);
    const login = JSON.parse(s.log.find(r => r.path === '/v1/auth/login')!.bodyText!);
    expect(Object.keys(login).sort()).toEqual(['authKey', 'email']);
    for (const r of s.log.filter(r => r.path.startsWith('/v1/docs/') && r.method === 'PUT')) {
      expect(Object.keys(JSON.parse(r.bodyText!)).sort()).toEqual(['ct', 'iv', 'v']);
    }
    // the leak detector itself works
    expect(findLeak(s.log, [], [C.b64u(new TextEncoder().encode(PW)).slice(0, 8), 'authKey'])).not.toBeNull();
  });
});
