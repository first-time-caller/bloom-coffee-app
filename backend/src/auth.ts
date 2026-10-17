import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { AuthSecret, WrappedKey, kdfSchema } from './e2ee';
import { hashPassword, verifyPassword } from './passwords';
import { ApiError, DEFAULT_KDF_ITERATIONS, b64url, randomToken, sha256hex, type AppEnv, type Ctx } from './util';
import { parseJson } from './validate';

/** Sessions live 30 days and slide forward on use (refreshed at most once an hour to avoid a write per request). */
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const REFRESH_AFTER_MS = 3600 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;

/** Same normalisation the client uses for the key-derivation salt: NFKC, trimmed, lower-cased. */
const email = z.string().max(254).transform(s => s.normalize('NFKC').trim().toLowerCase()).pipe(z.string().email());
const name = z.string().trim().max(60).optional().default('');

// The server only ever receives client-derived proofs (authKey, recoveryAuth) and ciphertext. Bodies are strict, so a
// stray `password` (or any other field) is rejected rather than silently accepted and ignored.
const signupBody = (c: Ctx) => z.object({
  email, name, authKey: AuthSecret, kdf: kdfSchema(c), wrappedDek: WrappedKey, recoveryWrappedDek: WrappedKey, recoveryAuth: AuthSecret
}).strict();
const PreloginBody = z.object({ email }).strict();
const LoginBody = z.object({ email, authKey: AuthSecret }).strict();
const RecoverBegin = z.object({ email, recoveryAuth: AuthSecret }).strict();
const recoverFinish = (c: Ctx) => z.object({ email, recoveryAuth: AuthSecret, authKey: AuthSecret, kdf: kdfSchema(c), wrappedDek: WrappedKey }).strict();
const changeBody = (c: Ctx) => z.object({ currentAuthKey: AuthSecret, newAuthKey: AuthSecret, kdf: kdfSchema(c), wrappedDek: WrappedKey }).strict();

/** Fixed-window counter in D1. Returns false once `limit` hits within the window are exceeded. */
async function hit(c: Ctx, key: string, limit: number): Promise<boolean> {
  const now = Date.now();
  const row = await c.env.DB.prepare(
    `INSERT INTO rate_limits(key, window_start, count) VALUES(?1, ?2, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN ?2 - window_start > ?3 THEN 1 ELSE count + 1 END,
       window_start = CASE WHEN ?2 - window_start > ?3 THEN ?2 ELSE window_start END
     RETURNING count`
  ).bind(key, now, RATE_WINDOW_MS).first<{ count: number }>();
  return (row?.count ?? 1) <= limit;
}

async function rateLimit(c: Ctx, scope: string, ident: string, factor = 1) {
  const limit = Math.max(1, Math.round((Number(c.env.AUTH_RATE_LIMIT) || 20) * factor));
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const okIp = await hit(c, `${scope}:ip:${ip}`, limit);
  const okId = await hit(c, `${scope}:id:${ident}`, limit);
  if (!okIp || !okId) throw new ApiError(429, 'rate_limited', 'Too many attempts. Try again in a few minutes.');
}

async function createSession(c: Ctx, userId: string): Promise<{ token: string; expiresAt: number }> {
  const token = randomToken(32);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  await c.env.DB.prepare('INSERT INTO sessions(token_hash,user_id,created_at,last_used_at,expires_at) VALUES(?,?,?,?,?)')
    .bind(await sha256hex(token), userId, now, now, expiresAt).run();
  // opportunistic cleanup of this user's expired sessions
  await c.env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND expires_at<?').bind(userId, now).run();
  return { token, expiresAt };
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,128})$/.exec(c.req.header('Authorization') ?? '');
  if (!m) throw new ApiError(401, 'unauthorized', 'Sign in required');
  const th = await sha256hex(m[1]);
  const now = Date.now();
  const s = await c.env.DB.prepare('SELECT user_id, last_used_at, expires_at FROM sessions WHERE token_hash=?').bind(th)
    .first<{ user_id: string; last_used_at: number; expires_at: number }>();
  if (!s || s.expires_at <= now) {
    if (s) await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(th).run();
    throw new ApiError(401, 'unauthorized', 'Session expired or invalid');
  }
  if (now - s.last_used_at > REFRESH_AFTER_MS)
    await c.env.DB.prepare('UPDATE sessions SET last_used_at=?, expires_at=? WHERE token_hash=?').bind(now, now + SESSION_TTL_MS, th).run();
  c.set('userId', s.user_id);
  c.set('tokenHash', th);
  await next();
};

export const auth = new Hono<AppEnv>();

type UserRow = {
  id: string; email: string; name: string; pw_hash: string;
  kdf_alg: string | null; kdf_iterations: number | null; kdf_salt: string | null;
  wrapped_dek: string | null; recovery_wrapped_dek: string | null; recovery_hash: string | null;
};
const USER_COLS = 'id,email,name,pw_hash,kdf_alg,kdf_iterations,kdf_salt,wrapped_dek,recovery_wrapped_dek,recovery_hash';
const kdfOf = (u: UserRow) => u.kdf_alg && u.kdf_iterations && u.kdf_salt ? { alg: u.kdf_alg, iterations: u.kdf_iterations, salt: u.kdf_salt } : null;

/** Decoy parameters for emails that do not exist: deterministic per email (same answer every time) and indistinguishable from real ones. */
async function decoyKdf(c: Ctx, addr: string) {
  let secret = c.env.PRELOGIN_SECRET;
  if (!secret) {
    await c.env.DB.prepare("INSERT OR IGNORE INTO server_config(key,value) VALUES('prelogin_secret', ?)").bind(randomToken(32)).run();
    secret = (await c.env.DB.prepare("SELECT value FROM server_config WHERE key='prelogin_secret'").first<{ value: string }>())?.value ?? '';
  }
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('bloom-prelogin-v1|' + addr)));
  return { alg: 'pbkdf2-sha256', iterations: DEFAULT_KDF_ITERATIONS, salt: b64url(mac.subarray(0, 16)) };
}

/** Key-derivation parameters for an email, so the client can derive its keys before logging in. Unknown emails get decoys. */
auth.post('/prelogin', async c => {
  const body = await parseJson(c, PreloginBody, 1024);
  await rateLimit(c, 'prelogin', c.req.header('CF-Connecting-IP') ?? 'unknown', 3);
  const u = await c.env.DB.prepare('SELECT kdf_alg,kdf_iterations,kdf_salt FROM users WHERE email=?').bind(body.email)
    .first<Pick<UserRow, 'kdf_alg' | 'kdf_iterations' | 'kdf_salt'>>();
  const real = u && u.kdf_alg && u.kdf_iterations && u.kdf_salt ? { alg: u.kdf_alg, iterations: u.kdf_iterations, salt: u.kdf_salt } : null;
  return c.json(real ?? (await decoyKdf(c, body.email)));
});

auth.post('/signup', async c => {
  const body = await parseJson(c, signupBody(c), 8192);
  await rateLimit(c, 'signup', body.email);
  const id = crypto.randomUUID();
  const [pw, rec] = await Promise.all([hashPassword(body.authKey), hashPassword(body.recoveryAuth)]);
  try {
    await c.env.DB.prepare(
      `INSERT INTO users(id,email,name,pw_hash,created_at,kdf_alg,kdf_iterations,kdf_salt,wrapped_dek,recovery_wrapped_dek,recovery_hash)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(id, body.email, body.name, pw, new Date().toISOString(), body.kdf.alg, body.kdf.iterations, body.kdf.salt,
      JSON.stringify(body.wrappedDek), JSON.stringify(body.recoveryWrappedDek), rec).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) throw new ApiError(409, 'email_taken', 'An account with that email already exists');
    throw e;
  }
  const s = await createSession(c, id);
  return c.json({ token: s.token, expiresAt: s.expiresAt, user: { id, email: body.email, name: body.name } }, 201);
});

auth.post('/login', async c => {
  const body = await parseJson(c, LoginBody, 2048);
  await rateLimit(c, 'login', body.email);
  const u = await c.env.DB.prepare(`SELECT ${USER_COLS} FROM users WHERE email=?`).bind(body.email).first<UserRow>();
  const ok = await verifyPassword(body.authKey, u?.pw_hash ?? null);
  if (!u || !ok) throw new ApiError(401, 'invalid_credentials', 'Incorrect email or password');
  const kdf = kdfOf(u);
  if (!kdf || !u.wrapped_dek) throw new ApiError(409, 'legacy_account', 'This account predates end-to-end encryption and cannot be opened by this app version');
  const s = await createSession(c, u.id);
  return c.json({ token: s.token, expiresAt: s.expiresAt, user: { id: u.id, email: u.email, name: u.name }, kdf, wrappedDek: JSON.parse(u.wrapped_dek) });
});

/** The wrapped data key and KDF parameters for the signed-in user (used to unlock a session and to change the password). */
auth.get('/keys', requireAuth, async c => {
  const u = await c.env.DB.prepare('SELECT kdf_alg,kdf_iterations,kdf_salt,wrapped_dek,key_version FROM users WHERE id=?').bind(c.get('userId'))
    .first<{ kdf_alg: string | null; kdf_iterations: number | null; kdf_salt: string | null; wrapped_dek: string | null; key_version: number }>();
  if (!u || !u.wrapped_dek || !u.kdf_alg) throw new ApiError(401, 'unauthorized', 'Account no longer exists');
  return c.json({ kdf: { alg: u.kdf_alg, iterations: u.kdf_iterations, salt: u.kdf_salt }, wrappedDek: JSON.parse(u.wrapped_dek), keyVersion: u.key_version });
});

/**
 * Change password. The client has already unwrapped the data key with the old password and re-wrapped it with the new
 * one; the server verifies the old authKey, swaps the hash, KDF parameters and wrapped key in one transaction, and
 * signs out every other session.
 */
auth.post('/change-password', requireAuth, async c => {
  const body = await parseJson(c, changeBody(c), 4096);
  const uid = c.get('userId');
  await rateLimit(c, 'chpw', uid);
  const u = await c.env.DB.prepare('SELECT pw_hash FROM users WHERE id=?').bind(uid).first<{ pw_hash: string }>();
  if (!u || !(await verifyPassword(body.currentAuthKey, u.pw_hash))) throw new ApiError(401, 'invalid_credentials', 'Current password is incorrect');
  const pw = await hashPassword(body.newAuthKey);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET pw_hash=?, kdf_alg=?, kdf_iterations=?, kdf_salt=?, wrapped_dek=? WHERE id=?')
      .bind(pw, body.kdf.alg, body.kdf.iterations, body.kdf.salt, JSON.stringify(body.wrappedDek), uid),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').bind(uid, c.get('tokenHash'))
  ]);
  return c.body(null, 204);
});

/**
 * Recovery with the recovery key, in two calls to the same endpoint.
 *  1. {email, recoveryAuth}: proves possession of the recovery key (the server only holds a hash of recoveryAuth) and
 *     returns the data key wrapped for recovery. The client unwraps it locally.
 *  2. {email, recoveryAuth, authKey, kdf, wrappedDek}: the client has chosen a new password and re-wrapped the data key.
 *     The server replaces the credentials, signs out every session, and returns a fresh one.
 */
auth.post('/recover', async c => {
  const raw = await parseJson(c, z.record(z.string(), z.unknown()), 8192);
  const finish = 'authKey' in raw ? await recoverFinish(c).parseAsync(raw).catch(zodFail) : null;
  const body = finish ?? (await RecoverBegin.parseAsync(raw).catch(zodFail));
  await rateLimit(c, 'recover', body.email, 0.5);
  const u = await c.env.DB.prepare(`SELECT ${USER_COLS} FROM users WHERE email=?`).bind(body.email).first<UserRow>();
  const ok = await verifyPassword(body.recoveryAuth, u?.recovery_hash ?? null);
  if (!u || !ok || !u.recovery_wrapped_dek) throw new ApiError(401, 'invalid_credentials', 'That recovery key does not match this account');
  if (!finish) return c.json({ recoveryWrappedDek: JSON.parse(u.recovery_wrapped_dek), kdf: kdfOf(u) });
  const pw = await hashPassword(finish.authKey);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET pw_hash=?, kdf_alg=?, kdf_iterations=?, kdf_salt=?, wrapped_dek=? WHERE id=?')
      .bind(pw, finish.kdf.alg, finish.kdf.iterations, finish.kdf.salt, JSON.stringify(finish.wrappedDek), u.id),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(u.id)
  ]);
  const s = await createSession(c, u.id);
  return c.json({ token: s.token, expiresAt: s.expiresAt, user: { id: u.id, email: u.email, name: u.name }, kdf: finish.kdf, wrappedDek: finish.wrappedDek });
});

function zodFail(e: unknown): never {
  const i = e instanceof z.ZodError ? e.issues[0] : null;
  throw new ApiError(422, 'validation_failed', i ? `${i.path.join('.') || 'body'}: ${i.message}` : 'Invalid body');
}

auth.post('/logout', requireAuth, async c => {
  await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(c.get('tokenHash')).run();
  return c.body(null, 204);
});
