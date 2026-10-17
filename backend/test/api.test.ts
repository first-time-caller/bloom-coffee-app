import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { api, signup, uniq } from './helpers';

const put = (token: string, col: string, id: string, json: unknown) => api(`/v1/docs/${col}/${id}`, { method: 'PUT', token, json });

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

  it('logs in with the right password only; stores only a hash of the token', async () => {
    const u = await signup();
    const bad = await api('/v1/auth/login', { method: 'POST', json: { email: u.email, password: 'wrong password' } });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: { code: 'invalid_credentials', message: expect.any(String) } });
    const ok = await api('/v1/auth/login', { method: 'POST', json: { email: u.email.toUpperCase(), password: u.password } });
    expect(ok.status).toBe(200);
    const { token } = (await ok.json()) as { token: string };
    const raw = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash=?').bind(token).first<{ n: number }>();
    expect(raw!.n).toBe(0);
    const stored = await env.DB.prepare('SELECT pw_hash FROM users WHERE id=?').bind(u.id).first<{ pw_hash: string }>();
    expect(stored!.pw_hash).toMatch(/^pbkdf2\$sha256\$100000\$/);
    expect(stored!.pw_hash).not.toContain(u.password);
  });

  it('rejects duplicate email, short password, bad email, bad JSON', async () => {
    const u = await signup();
    const dup = await api('/v1/auth/signup', { method: 'POST', json: { email: u.email, password: 'another password' } });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as any).error.code).toBe('email_taken');
    expect((await api('/v1/auth/signup', { method: 'POST', json: { email: `${uniq()}@x.com`, password: 'short' } })).status).toBe(422);
    expect((await api('/v1/auth/signup', { method: 'POST', json: { email: 'nope', password: 'long enough pw' } })).status).toBe(422);
    expect((await api('/v1/auth/signup', { method: 'POST', body: '{oops', headers: { 'Content-Type': 'application/json' } })).status).toBe(400);
  });

  it('requires auth everywhere', async () => {
    for (const [m, p] of [['GET', '/v1/me'], ['GET', '/v1/sync'], ['PUT', '/v1/docs/a/b'], ['GET', '/v1/shots'], ['PUT', '/v1/shots/m/1']]) {
      const r = await api(p, { method: m });
      expect(r.status, `${m} ${p}`).toBe(401);
      expect(((await r.json()) as any).error.code).toBe('unauthorized');
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
    for (let i = 0; i < 12; i++) last = (await api('/v1/auth/login', { method: 'POST', ip: '203.0.113.9', json: { email, password: 'whatever pw' } })).status;
    expect(last).toBe(429);
  });
});

describe('documents', () => {
  it('put/get/delete a doc', async () => {
    const u = await signup();
    const r = await put(u.token, 'brews', 'b1', { createdAt: '2026-01-01', dose: 18 });
    expect(r.status).toBe(200);
    const g = await api('/v1/docs/brews/b1', { token: u.token });
    expect(((await g.json()) as any).data).toEqual({ createdAt: '2026-01-01', dose: 18 });
    expect((await api('/v1/docs/brews/b1', { method: 'DELETE', token: u.token })).status).toBe(204);
    expect((await api('/v1/docs/brews/b1', { token: u.token })).status).toBe(404);
    expect((await api('/v1/docs/brews/b1', { method: 'DELETE', token: u.token })).status).toBe(204);
  });

  it('isolates users from each other', async () => {
    const a = await signup(), b = await signup();
    await put(a.token, 'brews', 'secret', { v: 1 });
    expect((await api('/v1/docs/brews/secret', { token: b.token })).status).toBe(404);
    expect((await api('/v1/docs/brews/secret', { method: 'PATCH', token: b.token, json: { v: 2 } })).status).toBe(404);
    await api('/v1/docs/brews/secret', { method: 'DELETE', token: b.token });
    const sb = (await (await api('/v1/sync', { token: b.token })).json()) as any;
    expect(sb.docs).toEqual([]);
    const ga = (await (await api('/v1/docs/brews/secret', { token: a.token })).json()) as any;
    expect(ga.data).toEqual({ v: 1 });
    // same id in both accounts is independent
    await put(b.token, 'brews', 'secret', { v: 'b' });
    expect(((await (await api('/v1/docs/brews/secret', { token: a.token })).json()) as any).data).toEqual({ v: 1 });
  });

  it('PATCH shallow-merges and 404s on a missing doc', async () => {
    const u = await signup();
    await put(u.token, 'profile', 'p', { name: 'A', nested: { x: 1 }, keep: true });
    const r = await api('/v1/docs/profile/p', { method: 'PATCH', token: u.token, json: { name: 'B', nested: { y: 2 } } });
    expect(r.status).toBe(200);
    const g = (await (await api('/v1/docs/profile/p', { token: u.token })).json()) as any;
    expect(g.data).toEqual({ name: 'B', nested: { y: 2 }, keep: true });
    expect((await api('/v1/docs/profile/nope', { method: 'PATCH', token: u.token, json: { a: 1 } })).status).toBe(404);
  });

  it('sync: monotonic seq, cursor, pagination, tombstones, collection filter', async () => {
    const u = await signup();
    const r1 = (await (await put(u.token, 'brews', 'a', { n: 1 })).json()) as any;
    const r2 = (await (await put(u.token, 'bags', 'x', { n: 2 })).json()) as any;
    const r3 = (await (await put(u.token, 'brews', 'a', { n: 3 })).json()) as any;
    expect(r1.seq).toBeLessThan(r2.seq);
    expect(r2.seq).toBeLessThan(r3.seq);

    const full = (await (await api('/v1/sync', { token: u.token })).json()) as any;
    expect(full.docs.map((d: any) => `${d.collection}/${d.id}`)).toEqual(['bags/x', 'brews/a']);
    expect(full.cursor).toBe(r3.seq);
    expect(full.hasMore).toBe(false);

    const none = (await (await api(`/v1/sync?since=${full.cursor}`, { token: u.token })).json()) as any;
    expect(none.docs).toEqual([]);
    expect(none.cursor).toBe(full.cursor);

    await put(u.token, 'brews', 'b', { n: 4 });
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
    expect((await put(u.token, 'bad name', 'x', {})).status).toBe(422);
    expect((await put(u.token, 'brews', 'x'.repeat(200), {})).status).toBe(422);
    expect((await put(u.token, 'brews', 'x', [1, 2])).status).toBe(422);
    expect((await put(u.token, 'brews', 'x', 'str')).status).toBe(422);
    const big = await put(u.token, 'brews', 'big', { blob: 'a'.repeat(300 * 1024) });
    expect(big.status).toBe(413);
    expect(((await big.json()) as any).error.code).toBe('too_large');
    expect((await api('/v1/sync?since=-1', { token: u.token })).status).toBe(422);
    expect((await put(u.token, 'brews', 'ok', { blob: 'a'.repeat(200 * 1024) })).status).toBe(200);
  });

  it('enforces the per-user document cap', async () => {
    const u = await signup();
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<20000)
       INSERT INTO docs(user_id,collection,id,data,deleted,updated_at,seq) SELECT ?, 'fill', 'd'||i, '{}', 0, 'x', 1 FROM n`
    ).bind(u.id).run();
    const r = await put(u.token, 'brews', 'one-too-many', {});
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).error.code).toBe('quota_exceeded');
    // overwriting an existing doc is still allowed
    expect((await put(u.token, 'fill', 'd1', { a: 1 })).status).toBe(200);
  });
});

describe('shots', () => {
  const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 255);
  const upload = (token: string, m: string, s: string, body: Uint8Array, headers: Record<string, string> = {}) =>
    api(`/v1/shots/${m}/${s}`, { method: 'PUT', token, body, headers: { 'Content-Type': 'application/octet-stream', ...headers } });

  it('uploads, lists, downloads bytes exactly, and is idempotent', async () => {
    const u = await signup();
    const data = bytes(5000);
    const meta = JSON.stringify({ profileName: 'Londinium', durationMs: 28000 });
    const r = await upload(u.token, 'gm-1', '42', data, { 'X-Shot-Meta': meta });
    expect(r.status).toBe(201);
    expect((await upload(u.token, 'gm-1', '42', data)).status).toBe(200);
    const list = (await (await api('/v1/shots', { token: u.token })).json()) as any;
    expect(list.shots).toHaveLength(1);
    expect(list.shots[0]).toMatchObject({ machineId: 'gm-1', shotId: '42', size: 5000, meta: { profileName: 'Londinium' } });
    const dl = await api('/v1/shots/gm-1/42', { token: u.token });
    expect(dl.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(data);
    expect((await api('/v1/shots/gm-1/99', { token: u.token })).status).toBe(404);
  });

  it('isolates shots between users', async () => {
    const a = await signup(), b = await signup();
    await upload(a.token, 'gm', '1', bytes(10));
    expect((await api('/v1/shots/gm/1', { token: b.token })).status).toBe(404);
    expect(((await (await api('/v1/shots', { token: b.token })).json()) as any).shots).toEqual([]);
  });

  it('enforces size, content type, empty body, bad meta and ids', async () => {
    const u = await signup();
    expect((await upload(u.token, 'gm', '1', bytes(1024 * 1024))).status).toBe(201);
    const big = await upload(u.token, 'gm', '2', bytes(1024 * 1024 + 1));
    expect(big.status).toBe(413);
    expect((await api('/v1/shots/gm/3', { method: 'PUT', token: u.token, json: { a: 1 } })).status).toBe(415);
    expect((await upload(u.token, 'gm', '4', new Uint8Array(0))).status).toBe(422);
    expect((await upload(u.token, 'gm', '5', bytes(4), { 'X-Shot-Meta': 'not json' })).status).toBe(422);
    expect((await upload(u.token, 'gm', 'a b', bytes(4))).status).toBe(422);
  });
});

describe('cors and errors', () => {
  it('allows Capacitor and configured origins, not others', async () => {
    const ok = await api('/v1/me', { method: 'OPTIONS', headers: { Origin: 'capacitor://localhost', 'Access-Control-Request-Method': 'GET' } });
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('capacitor://localhost');
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
