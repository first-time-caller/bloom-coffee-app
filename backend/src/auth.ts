import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { hashPassword, verifyPassword } from './passwords';
import { ApiError, randomToken, sha256hex, type AppEnv, type Ctx } from './util';
import { parseJson } from './validate';

/** Sessions live 30 days and slide forward on use (refreshed at most once an hour to avoid a write per request). */
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const REFRESH_AFTER_MS = 3600 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;

const email = z.string().trim().toLowerCase().max(254).email();
const password = z.string().min(8, 'Password must be at least 8 characters').max(200);
const SignupBody = z.object({ email, password, name: z.string().trim().max(60).optional().default('') });
const LoginBody = z.object({ email, password: z.string().min(1).max(200) });

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

async function rateLimit(c: Ctx, scope: string, ident: string) {
  const limit = Number(c.env.AUTH_RATE_LIMIT) || 20;
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

auth.post('/signup', async c => {
  const body = await parseJson(c, SignupBody, 4096);
  await rateLimit(c, 'signup', body.email);
  const id = crypto.randomUUID();
  const pw = await hashPassword(body.password);
  try {
    await c.env.DB.prepare('INSERT INTO users(id,email,name,pw_hash,created_at) VALUES(?,?,?,?,?)')
      .bind(id, body.email, body.name, pw, new Date().toISOString()).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) throw new ApiError(409, 'email_taken', 'An account with that email already exists');
    throw e;
  }
  const s = await createSession(c, id);
  return c.json({ token: s.token, expiresAt: s.expiresAt, user: { id, email: body.email, name: body.name } }, 201);
});

auth.post('/login', async c => {
  const body = await parseJson(c, LoginBody, 4096);
  await rateLimit(c, 'login', body.email);
  const u = await c.env.DB.prepare('SELECT id,email,name,pw_hash FROM users WHERE email=?').bind(body.email)
    .first<{ id: string; email: string; name: string; pw_hash: string }>();
  const ok = await verifyPassword(body.password, u?.pw_hash ?? null);
  if (!u || !ok) throw new ApiError(401, 'invalid_credentials', 'Incorrect email or password');
  const s = await createSession(c, u.id);
  return c.json({ token: s.token, expiresAt: s.expiresAt, user: { id: u.id, email: u.email, name: u.name } });
});

auth.post('/logout', requireAuth, async c => {
  await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(c.get('tokenHash')).run();
  return c.body(null, 204);
});
