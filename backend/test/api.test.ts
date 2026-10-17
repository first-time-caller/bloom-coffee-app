import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import app from '../src/index';
import { api, envelope, kdf, rnd, shotBlob, signup, signupBody, uniq, wrapped } from './helpers';

const put = (token: string, col: string, id: string, json: unknown = envelope(), q = '') => api(`/v1/docs/${col}/${id}${q}`, { method: 'PUT', token, json });
const get = async (token: string, col: string, id: string) => api(`/v1/docs/${col}/${id}`, { token });
const login = (email: string, authKey: string, ip?: string) => api('/v1/auth/login', { method: 'POST', ip, json: { email, authKey } });
const errCode = async (r: Response) => ((await r.json()) as any).error.code;

describe('auth', () => {
  it('signs up, returns /v1/me, logs out, then rejects the token', async () => {
    const u = await signup();
    expect(u.status).toBe(201);
    const me = await api('/v1/me', { token: u.token });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ id: u.id, email: u.email, name: 'Test' });
    expect((await api('/v1/auth/logout', { method: 'POST', token: u.token })).status).toBe(204);
    expect((await api('/v1/me', { token: u.token })).status).toBe(401);
  });

  it('logs in with the right authKey only and returns the KDF parameters and wrapped data key', async () => {
    const u = await signup();
    const bad = await login(u.email, rnd(32));
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: { code: 'invalid_credentials', message: expect.any(String) } });
    const ok = await login(u.email.toUpperCase(), u.authKey);
    expect(ok.status).toBe(200);
    const j = (await ok.json()) as any;
    expect(j.kdf).toEqual(u.kdf);
    expect(j.wrappedDek).toEqual(u.wrappedDek);
    expect(j.user).toMatchObject({ id: u.id, email: u.email });
    expect(j).not.toHaveProperty('recoveryWrappedDek');
  });

  it('stores only a hash of the token and of the authKey, and never anything that looks like a password', async () => {
    const u = await signup();
    const { token } = (await (await login(u.email, u.authKey)).json()) as { token: string };
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash=?').bind(token).first<{ n: number }>())!.n).toBe(0);
    const row = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(u.id).first<Record<string, any>>();
    expect(row!.pw_hash).toMatch(/^pbkdf2\$sha256\$100000\$/);
    expect(row!.recovery_hash).toMatch(/^pbkdf2\$sha256\$100000\$/);
    const dump = JSON.stringify(row);
    for (const secret of [u.authKey, u.recoveryAuth]) expect(dump).not.toContain(secret);
    expect(row).toMatchObject({ kdf_alg: 'pbkdf2-sha256', kdf_iterations: 1000, kdf_salt: u.kdf.salt, key_version: 1 });
    expect(JSON.parse(row!.wrapped_dek)).toEqual(u.wrappedDek);
    expect(JSON.parse(row!.recovery_wrapped_dek)).toEqual(u.recoveryWrappedDek);
  });

  it('rejects duplicate email, malformed keys, a stray password field, weak KDF settings and bad JSON', async () => {
    const u = await signup();
    const dup = await api('/v1/auth/signup', { method: 'POST', json: { ...signupBody(), email: u.email } });
    expect(dup.status).toBe(409);
    expect(await errCode(dup)).toBe('email_taken');
    const post = (body: unknown) => api('/v1/auth/signup', { method: 'POST', json: body });
    const ok = () => signupBody(`${uniq()}@x.com`);
    expect((await post({ ...ok(), email: 'nope' })).status).toBe(422);
    expect((await post({ ...ok(), authKey: 'short' })).status).toBe(422);
    expect((await post({ ...ok(), authKey: '!'.repeat(43) })).status).toBe(422);
    expect((await post({ ...ok(), password: 'hunter2hunter2' })).status).toBe(422); // plaintext password field is refused outright
    const { authKey, ...noKey } = ok();
    expect((await post(noKey)).status).toBe(422);
    expect((await post({ ...ok(), wrappedDek: envelope(20) })).status).toBe(422); // wrong length for a wrapped 256-bit key
    expect((await post({ ...ok(), recoveryWrappedDek: { v: 2, iv: rnd(12), ct: rnd(48) } })).status).toBe(422);
    expect((await post({ ...ok(), kdf: kdf(999) })).status).toBe(422); // below the floor (test floor is 1000)
    expect((await post({ ...ok(), kdf: { ...kdf(), alg: 'md5' } })).status).toBe(422);
    expect((await post({ ...ok(), kdf: kdf(20_000_000) })).status).toBe(422);
    expect((await post({ ...ok(), kdf: { ...kdf(), salt: 'a' } })).status).toBe(422);
    expect((await api('/v1/auth/signup', { method: 'POST', body: '{oops', headers: { 'Content-Type': 'application/json' } })).status).toBe(400);
  });

  it('enforces the production KDF floor of 600,000 rounds when no override is set', async () => {
    const e = { ...env, MIN_KDF_ITERATIONS: undefined } as typeof env;
    const send = (iterations: number) => app.fetch(new Request('http://bloom.test/v1/auth/signup', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.9.9.' + (iterations % 250) },
      body: JSON.stringify({ ...signupBody(`${uniq()}@x.com`), kdf: kdf(iterations) })
    }), e);
    expect((await send(599_999)).status).toBe(422);
    expect((await send(600_000)).status).toBe(201);
  });

  it('requires auth everywhere', async () => {
    for (const [m, p] of [['GET', '/v1/me'], ['GET', '/v1/sync'], ['PUT', '/v1/docs/a/b'], ['GET', '/v1/shots'], ['PUT', '/v1/shots/m/1'], ['GET', '/v1/auth/keys'], ['POST', '/v1/auth/change-password']]) {
      const r = await api(p, { method: m });
      expect(r.status, `${m} ${p}`).toBe(401);
      expect(await errCode(r)).toBe('unauthorized');
    }
    expect((await api('/v1/me', { token: 'x'.repeat(43) })).status).toBe(401);
  });

  it('expires sessions and refreshes on use', async () => {
    const u = await signup();
    const h = (await crypto.subtle.digest('SHA-256', new TextEncoder().encode(u.token)));
    const th = [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
    await env.DB.prepare('UPDATE sessions SET last_used_at=?, expires_at=? WHERE token_hash=?').bind(Date.now() - 7200_000, Date.now() + 1000, th).run();
    expect((await api('/v1/me', { token: u.token })).status).toBe(200);
    const row = await env.DB.prepare('SELECT expires_at FROM sessions WHERE token_hash=?').bind(th).first<{ expires_at: number }>();
    expect(row!.expires_at).toBeGreaterThan(Date.now() + 29 * 86400_000);
    await env.DB.prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?').bind(Date.now() - 1, th).run();
    expect((await api('/v1/me', { token: u.token })).status).toBe(401);
  });

  it('rate limits repeated bad logins', async () => {
    const email = `${uniq('rl')}@example.com`;
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await login(email, rnd(32), '203.0.113.9')).status;
    expect(last).toBe(429);
  });

  it('refuses a login for an account created before end-to-end encryption', async () => {
    const authKey = rnd(32);
    const { hashPassword } = await import('../src/passwords');
    const email = `${uniq('old')}@example.com`;
    await env.DB.prepare('INSERT INTO users(id,email,name,pw_hash,created_at) VALUES(?,?,?,?,?)').bind(uniq('id'), email, '', await hashPassword(authKey), 'x').run();
    const r = await login(email, authKey);
    expect(r.status).toBe(409);
    expect(await errCode(r)).toBe('legacy_account');
  });
});

describe('prelogin', () => {
  const pre = (email: string, ip?: string) => api('/v1/auth/prelogin', { method: 'POST', ip, json: { email } });

  it('returns the stored parameters for a real account', async () => {
    const u = await signup();
    expect(await (await pre(u.email.toUpperCase())).json()).toEqual(u.kdf);
  });

  it('returns stable, well-formed decoy parameters for unknown emails (no account enumeration)', async () => {
    const a = (await (await pre('ghost@example.com')).json()) as any;
    expect(a).toMatchObject({ alg: 'pbkdf2-sha256', iterations: 600_000 });
    expect(a.salt).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await (await pre('ghost@example.com')).json()).toEqual(a); // deterministic
    expect(await (await pre('GHOST@example.com ')).json()).toEqual(a); // normalised
    expect(((await (await pre('other-ghost@example.com')).json()) as any).salt).not.toBe(a.salt);
    // the same shape as a real account's answer
    const real = (await signup()) && ((await (await pre((await signup()).email)).json()) as any);
    expect(Object.keys(real).sort()).toEqual(Object.keys(a).sort());
  });

  it('derives decoys from PRELOGIN_SECRET when configured, so they differ per deployment', async () => {
    const call = (secret: string) => (app.fetch(new Request('http://bloom.test/v1/auth/prelogin', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.8.8.8' }, body: JSON.stringify({ email: 'ghost2@example.com' })
    }), { ...env, PRELOGIN_SECRET: secret } as typeof env) as Promise<Response>).then(r => r.json() as Promise<any>);
    const [a, b, a2] = [await call('secret-one'), await call('secret-two'), await call('secret-one')];
    expect(a.salt).toBe(a2.salt);
    expect(a.salt).not.toBe(b.salt);
  });

  it('validates input and is rate limited per IP', async () => {
    expect((await pre('not-an-email')).status).toBe(422);
    expect((await api('/v1/auth/prelogin', { method: 'POST', json: { email: 'a@b.co', extra: 1 } })).status).toBe(422);
    let last = 0;
    for (let i = 0; i < 40; i++) last = (await pre('a@b.co', '198.51.100.7')).status;
    expect(last).toBe(429);
  });
});

describe('keys and password change', () => {
  it('GET /v1/auth/keys returns this user\'s wrapped key and KDF parameters', async () => {
    const u = await signup();
    expect(await (await api('/v1/auth/keys', { token: u.token })).json()).toEqual({ kdf: u.kdf, wrappedDek: u.wrappedDek, keyVersion: 1 });
  });

  it('change-password verifies the current authKey, swaps credentials atomically, and signs out other sessions', async () => {
    const u = await signup();
    const other = ((await (await login(u.email, u.authKey)).json()) as any).token as string;
    const next = { currentAuthKey: u.authKey, newAuthKey: rnd(32), kdf: kdf(2000), wrappedDek: wrapped() };
    const wrong = await api('/v1/auth/change-password', { method: 'POST', token: u.token, json: { ...next, currentAuthKey: rnd(32) } });
    expect(wrong.status).toBe(401);
    expect((await api('/v1/auth/change-password', { method: 'POST', token: u.token, json: { ...next, password: 'x' } })).status).toBe(422);
    expect((await api('/v1/auth/change-password', { method: 'POST', token: u.token, json: { ...next, kdf: kdf(10) } })).status).toBe(422);
    expect((await api('/v1/auth/change-password', { method: 'POST', token: u.token, json: next })).status).toBe(204);
    expect((await api('/v1/me', { token: u.token })).status).toBe(200); // the caller stays signed in
    expect((await api('/v1/me', { token: other })).status).toBe(401);
    expect((await login(u.email, u.authKey)).status).toBe(401);
    const ok = (await (await login(u.email, next.newAuthKey)).json()) as any;
    expect(ok.kdf).toEqual(next.kdf);
    expect(ok.wrappedDek).toEqual(next.wrappedDek);
    // the recovery material is untouched by a password change
    const r = await env.DB.prepare('SELECT recovery_wrapped_dek FROM users WHERE id=?').bind(u.id).first<{ recovery_wrapped_dek: string }>();
    expect(JSON.parse(r!.recovery_wrapped_dek)).toEqual(u.recoveryWrappedDek);
  });
});

describe('recovery', () => {
  const recover = (body: unknown, ip?: string) => api('/v1/auth/recover', { method: 'POST', json: body, ip });

  it('proves possession of the recovery key, hands back the recovery-wrapped key, then accepts a new password', async () => {
    const u = await signup();
    const begin = await recover({ email: u.email, recoveryAuth: u.recoveryAuth });
    expect(begin.status).toBe(200);
    expect(await begin.json()).toEqual({ recoveryWrappedDek: u.recoveryWrappedDek, kdf: u.kdf });

    const finish = { email: u.email, recoveryAuth: u.recoveryAuth, authKey: rnd(32), kdf: kdf(3000), wrappedDek: wrapped() };
    const done = await recover(finish);
    expect(done.status).toBe(200);
    const j = (await done.json()) as any;
    expect(j.kdf).toEqual(finish.kdf);
    expect(j.wrappedDek).toEqual(finish.wrappedDek);
    expect((await api('/v1/me', { token: j.token })).status).toBe(200);
    expect((await api('/v1/me', { token: u.token })).status).toBe(401); // every older session is revoked
    expect((await login(u.email, u.authKey)).status).toBe(401);
    expect((await login(u.email, finish.authKey)).status).toBe(200);
  });

  it('rejects a wrong recovery key or unknown email identically, and malformed bodies', async () => {
    const u = await signup();
    const wrongKey = await recover({ email: u.email, recoveryAuth: rnd(32) });
    const unknown = await recover({ email: 'nobody@example.com', recoveryAuth: u.recoveryAuth });
    expect(wrongKey.status).toBe(401);
    expect(await wrongKey.json()).toEqual(await unknown.json());
    expect((await recover({ email: u.email, recoveryAuth: rnd(32), authKey: rnd(32), kdf: kdf(), wrappedDek: wrapped() })).status).toBe(401);
    expect((await recover({ email: u.email })).status).toBe(422);
    expect((await recover({ email: u.email, recoveryAuth: u.recoveryAuth, authKey: rnd(32) })).status).toBe(422);
    expect((await recover({ email: u.email, recoveryAuth: u.recoveryAuth, extra: 1 })).status).toBe(422);
    expect((await login(u.email, u.authKey)).status).toBe(200); // nothing changed
  });

  it('is rate limited', async () => {
    let last = 0;
    for (let i = 0; i < 8; i++) last = (await recover({ email: 'rl@example.com', recoveryAuth: rnd(32) }, '192.0.2.50')).status;
    expect(last).toBe(429);
  });
});

describe('documents are ciphertext only', () => {
  it('put/get/delete a doc', async () => {
    const u = await signup();
    const e = envelope();
    const r = await put(u.token, 'brews', 'b1', e);
    expect(r.status).toBe(200);
    const g = await get(u.token, 'brews', 'b1');
    expect(((await g.json()) as any).data).toEqual(e);
    expect((await api('/v1/docs/brews/b1', { method: 'DELETE', token: u.token })).status).toBe(204);
    expect((await get(u.token, 'brews', 'b1')).status).toBe(404);
    expect((await api('/v1/docs/brews/b1', { method: 'DELETE', token: u.token })).status).toBe(204);
  });

  it('rejects plaintext bodies and anything that is not a v1 envelope; nothing is stored', async () => {
    const u = await signup();
    const bad: unknown[] = [
      { createdAt: '2026-01-01', note: 'plaintext brew', dose: 18 },
      { v: 1, iv: rnd(12), ct: rnd(40), note: 'smuggled' },
      { v: 1, iv: rnd(12) },
      { v: 2, iv: rnd(12), ct: rnd(40) },
      { v: 1, iv: rnd(8), ct: rnd(40) },
      { v: 1, iv: rnd(12), ct: rnd(10) },
      { v: 1, iv: rnd(12), ct: 'not base64url!!' },
      { v: 1, iv: rnd(12), ct: 123 },
      [envelope()], 'str', null
    ];
    for (const b of bad) {
      const r = await put(u.token, 'brews', 'x', b);
      expect(r.status, JSON.stringify(b)).toBe(422);
    }
    const unreadable = await api('/v1/docs/brews/x', { method: 'PUT', token: u.token, body: '{broken', headers: { 'Content-Type': 'application/json' } });
    expect(unreadable.status).toBe(400);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM docs WHERE user_id=?').bind(u.id).first<{ n: number }>())!.n).toBe(0);
  });

  it('has no server-side merge: PATCH is gone', async () => {
    const u = await signup();
    await put(u.token, 'profile', 'p');
    expect((await api('/v1/docs/profile/p', { method: 'PATCH', token: u.token, json: { name: 'B' } })).status).toBe(404);
  });

  it('isolates users from each other', async () => {
    const a = await signup(), b = await signup();
    const ea = envelope();
    await put(a.token, 'brews', 'secret', ea);
    expect((await get(b.token, 'brews', 'secret')).status).toBe(404);
    await api('/v1/docs/brews/secret', { method: 'DELETE', token: b.token });
    expect(((await (await api('/v1/sync', { token: b.token })).json()) as any).docs).toEqual([]);
    expect(((await (await get(a.token, 'brews', 'secret')).json()) as any).data).toEqual(ea);
    const eb = envelope();
    await put(b.token, 'brews', 'secret', eb);
    expect(((await (await get(a.token, 'brews', 'secret')).json()) as any).data).toEqual(ea);
  });

  it('stores the envelope text and nothing else in D1', async () => {
    const u = await signup();
    const e = envelope();
    await put(u.token, 'brews', 'b1', e);
    const row = await env.DB.prepare('SELECT data FROM docs WHERE user_id=?').bind(u.id).first<{ data: string }>();
    expect(JSON.parse(row!.data)).toEqual(e);
  });

  it('conditional writes: baseSeq must match the live seq, or 409 conflict', async () => {
    const u = await signup();
    const first = (await (await put(u.token, 'profile', 'p', envelope(), '?baseSeq=0')).json()) as any; // create: must not exist
    expect((await put(u.token, 'profile', 'p', envelope(), '?baseSeq=0')).status).toBe(409);
    const second = await put(u.token, 'profile', 'p', envelope(), `?baseSeq=${first.seq}`);
    expect(second.status).toBe(200);
    const stale = await put(u.token, 'profile', 'p', envelope(), `?baseSeq=${first.seq}`);
    expect(stale.status).toBe(409);
    expect(await errCode(stale)).toBe('conflict');
    const live = (await (await get(u.token, 'profile', 'p')).json()) as any;
    expect(live.seq).toBe(((await second.json()) as any).seq); // the loser changed nothing
    // a tombstone counts as "does not exist": baseSeq=0 recreates, a nonzero baseSeq does not
    await api('/v1/docs/profile/p', { method: 'DELETE', token: u.token });
    expect((await put(u.token, 'profile', 'p', envelope(), `?baseSeq=${live.seq}`)).status).toBe(409);
    expect((await put(u.token, 'profile', 'p', envelope(), '?baseSeq=0')).status).toBe(200);
    // unconditional PUT stays last-write-wins
    expect((await put(u.token, 'profile', 'p')).status).toBe(200);
    expect((await put(u.token, 'profile', 'p', envelope(), '?baseSeq=abc')).status).toBe(422);
    expect((await put(u.token, 'profile', 'p', envelope(), '?baseSeq=-1')).status).toBe(422);
  });

  it('two racing writers with the same baseSeq: exactly one wins', async () => {
    const u = await signup();
    const base = (await (await put(u.token, 'profile', 'race')).json()) as any;
    const results = await Promise.all(Array.from({ length: 6 }, () => put(u.token, 'profile', 'race', envelope(), `?baseSeq=${base.seq}`)));
    const codes = results.map(r => r.status).sort();
    expect(codes.filter(c => c === 200)).toHaveLength(1);
    expect(codes.filter(c => c === 409)).toHaveLength(5);
  });

  it('sync: monotonic seq, cursor, pagination, tombstones, collection filter', async () => {
    const u = await signup();
    const r1 = (await (await put(u.token, 'brews', 'a')).json()) as any;
    const r2 = (await (await put(u.token, 'bags', 'x')).json()) as any;
    const r3 = (await (await put(u.token, 'brews', 'a')).json()) as any;
    expect(r1.seq).toBeLessThan(r2.seq);
    expect(r2.seq).toBeLessThan(r3.seq);

    const full = (await (await api('/v1/sync', { token: u.token })).json()) as any;
    expect(full.docs.map((d: any) => `${d.collection}/${d.id}`)).toEqual(['bags/x', 'brews/a']);
    expect(full.docs[0].data).toMatchObject({ v: 1 });
    expect(full.cursor).toBe(r3.seq);
    expect(full.hasMore).toBe(false);

    const none = (await (await api(`/v1/sync?since=${full.cursor}`, { token: u.token })).json()) as any;
    expect(none.docs).toEqual([]);
    expect(none.cursor).toBe(full.cursor);

    await put(u.token, 'brews', 'b');
    await api('/v1/docs/bags/x', { method: 'DELETE', token: u.token });
    const inc = (await (await api(`/v1/sync?since=${full.cursor}`, { token: u.token })).json()) as any;
    expect(inc.docs.map((d: any) => [d.collection, d.id, d.deleted])).toEqual([['brews', 'b', false], ['bags', 'x', true]]);
    expect(inc.docs[1].data).toBeNull();

    const p1 = (await (await api('/v1/sync?since=0&limit=1', { token: u.token })).json()) as any;
    expect(p1.docs).toHaveLength(1);
    expect(p1.hasMore).toBe(true);
    const p2 = (await (await api(`/v1/sync?since=${p1.cursor}&limit=10`, { token: u.token })).json()) as any;
    expect(p2.hasMore).toBe(false);
    expect(p2.docs.length).toBeGreaterThan(0);

    const only = (await (await api('/v1/sync?collection=brews', { token: u.token })).json()) as any;
    expect(only.docs.every((d: any) => d.collection === 'brews')).toBe(true);
  });

  it('validates names, bodies and sizes', async () => {
    const u = await signup();
    expect((await put(u.token, 'bad name', 'x')).status).toBe(422);
    expect((await put(u.token, 'brews', 'x'.repeat(200))).status).toBe(422);
    const big = await put(u.token, 'brews', 'big', { v: 1, iv: rnd(12), ct: rnd(300 * 1024) });
    expect(big.status).toBe(413);
    expect(await errCode(big)).toBe('too_large');
    expect((await api('/v1/sync?since=-1', { token: u.token })).status).toBe(422);
    expect((await put(u.token, 'brews', 'ok', { v: 1, iv: rnd(12), ct: rnd(150 * 1024) })).status).toBe(200);
  });

  it('enforces the per-user document cap', async () => {
    const u = await signup();
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<20000)
       INSERT INTO docs(user_id,collection,id,data,deleted,updated_at,seq) SELECT ?, 'fill', 'd'||i, '{}', 0, 'x', 1 FROM n`
    ).bind(u.id).run();
    const r = await put(u.token, 'brews', 'one-too-many');
    expect(r.status).toBe(409);
    expect(await errCode(r)).toBe('quota_exceeded');
    expect((await put(u.token, 'fill', 'd1')).status).toBe(200); // overwriting an existing doc is still allowed
  });
});

describe('shots are ciphertext only', () => {
  const upload = (token: string, m: string, s: string, body: Uint8Array, headers: Record<string, string> = {}) =>
    api(`/v1/shots/${m}/${s}`, { method: 'PUT', token, body, headers: { 'Content-Type': 'application/octet-stream', ...headers } });

  it('uploads, lists ids/size/timestamps only, downloads bytes exactly, and is idempotent', async () => {
    const u = await signup();
    const data = shotBlob(5000);
    expect((await upload(u.token, 'gm-1', '42', data)).status).toBe(201);
    expect((await upload(u.token, 'gm-1', '42', data)).status).toBe(200);
    const list = (await (await api('/v1/shots', { token: u.token })).json()) as any;
    expect(list.shots).toHaveLength(1);
    expect(Object.keys(list.shots[0]).sort()).toEqual(['createdAt', 'machineId', 'shotId', 'size', 'updatedAt']);
    expect(list.shots[0]).toMatchObject({ machineId: 'gm-1', shotId: '42', size: data.length });
    const dl = await api('/v1/shots/gm-1/42', { token: u.token });
    expect(dl.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(dl.headers.get('X-Shot-Meta')).toBeNull();
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(data);
    expect((await api('/v1/shots/gm-1/99', { token: u.token })).status).toBe(404);
  });

  it('rejects plaintext .slog bytes and X-Shot-Meta; nothing is stored', async () => {
    const u = await signup();
    const slog = new TextEncoder().encode('a plaintext shot log with enough bytes to pass any length check.........');
    for (const body of [slog, shotBlob(0).slice(0, 20), Uint8Array.of(0x42, 0x53, 0x45, 0x02, ...new Uint8Array(40))]) {
      expect((await upload(u.token, 'gm', '1', body)).status).toBe(422);
    }
    const withMeta = await upload(u.token, 'gm', '2', shotBlob(10), { 'X-Shot-Meta': JSON.stringify({ profileName: 'Londinium' }) });
    expect(withMeta.status).toBe(422);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM shots WHERE user_id=?').bind(u.id).first<{ n: number }>())!.n).toBe(0);
  });

  it('isolates shots between users', async () => {
    const a = await signup(), b = await signup();
    await upload(a.token, 'gm', '1', shotBlob(10));
    expect((await api('/v1/shots/gm/1', { token: b.token })).status).toBe(404);
    expect(((await (await api('/v1/shots', { token: b.token })).json()) as any).shots).toEqual([]);
  });

  it('enforces size, content type, empty body and ids', async () => {
    const u = await signup();
    const max = 1024 * 1024 + 64;
    expect((await upload(u.token, 'gm', '1', shotBlob(max - 32))).status).toBe(201);
    const big = await upload(u.token, 'gm', '2', shotBlob(max - 31));
    expect(big.status).toBe(413);
    expect((await api('/v1/shots/gm/3', { method: 'PUT', token: u.token, json: { a: 1 } })).status).toBe(415);
    expect((await upload(u.token, 'gm', '4', new Uint8Array(0))).status).toBe(422);
    expect((await upload(u.token, 'gm', 'a b', shotBlob(4))).status).toBe(422);
  });

  it('lists with machine filter and paging', async () => {
    const u = await signup();
    await upload(u.token, 'm1', '1', shotBlob(5)); await upload(u.token, 'm2', '1', shotBlob(5));
    const only = (await (await api('/v1/shots?machineId=m2&limit=5', { token: u.token })).json()) as any;
    expect(only.shots.map((s: any) => s.machineId)).toEqual(['m2']);
    const before = (await (await api('/v1/shots?before=2000-01-01', { token: u.token })).json()) as any;
    expect(before.shots).toEqual([]);
    expect((await api('/v1/shots?limit=0', { token: u.token })).status).toBe(422);
  });
});

describe('cors and errors', () => {
  it('allows Capacitor and configured origins, not others, and no longer advertises PATCH or X-Shot-Meta', async () => {
    const ok = await api('/v1/me', { method: 'OPTIONS', headers: { Origin: 'capacitor://localhost', 'Access-Control-Request-Method': 'GET' } });
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('capacitor://localhost');
    expect(ok.headers.get('Access-Control-Allow-Methods')).not.toContain('PATCH');
    expect(ok.headers.get('Access-Control-Allow-Headers') ?? '').not.toContain('X-Shot-Meta');
    const web = await api('/v1/me', { method: 'OPTIONS', headers: { Origin: 'http://localhost:8080', 'Access-Control-Request-Method': 'GET' } });
    expect(web.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:8080');
    const bad = await api('/v1/me', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
    expect(bad.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
  it('returns JSON errors for unknown routes', async () => {
    const r = await api('/nope');
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: { code: 'not_found', message: expect.any(String) } });
  });
});
