import { SELF } from 'cloudflare:test';

export const BASE = 'http://bloom.test';
let n = 0;
export const uniq = (p = 'u') => `${p}${Date.now().toString(36)}${(n++).toString(36)}`;

export async function api(path: string, init: RequestInit & { token?: string; json?: unknown; ip?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('Authorization', `Bearer ${init.token}`);
  headers.set('CF-Connecting-IP', init.ip ?? `10.0.${n % 250}.${(n * 7) % 250}`);
  let body = init.body;
  if (init.json !== undefined) { body = JSON.stringify(init.json); headers.set('Content-Type', 'application/json'); }
  return SELF.fetch(BASE + path, { ...init, headers, body });
}

export async function signup(email = `${uniq()}@example.com`, password = 'correct horse battery', name = 'Test') {
  const r = await api('/v1/auth/signup', { method: 'POST', json: { email, password, name } });
  const j = (await r.json()) as { token: string; user: { id: string } };
  return { token: j.token, id: j.user.id, email, password, status: r.status };
}
