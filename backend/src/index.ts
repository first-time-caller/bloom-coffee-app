import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { auth, requireAuth } from './auth';
import { docs } from './docs';
import { shots } from './shots';
import { ApiError, type AppEnv } from './util';

const NATIVE_ORIGINS = ['capacitor://localhost', 'http://localhost', 'https://localhost'];

const app = new Hono<AppEnv>();

app.use('*', async (c, next) => {
  const allowed = new Set([...NATIVE_ORIGINS, ...(c.env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean)]);
  return cors({
    origin: o => (allowed.has(o) ? o : null),
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS'],
    maxAge: 600
  })(c, next);
});

app.use('*', async (c, next) => {
  await next();
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  if (!c.res.headers.has('Cache-Control')) c.res.headers.set('Cache-Control', 'no-store');
});

app.get('/', c => c.json({ name: 'bloom-backend', ok: true }));
app.route('/v1/auth', auth);
app.get('/v1/me', requireAuth, async c => {
  const u = await c.env.DB.prepare('SELECT id,email,name,created_at FROM users WHERE id=?').bind(c.get('userId')).first<{ id: string; email: string; name: string; created_at: string }>();
  if (!u) throw new ApiError(401, 'unauthorized', 'Account no longer exists');
  return c.json({ id: u.id, email: u.email, name: u.name, createdAt: u.created_at });
});
app.route('/v1', docs);
app.route('/v1', shots);

app.notFound(c => c.json({ error: { code: 'not_found', message: 'No such route' } }, 404));
app.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ error: { code: err.code, message: err.message } }, err.status);
  console.error(err);
  return c.json({ error: { code: 'internal', message: 'Something went wrong' } }, 500);
});

export default app;
