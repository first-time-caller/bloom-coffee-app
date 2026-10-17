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

/* ---- E2E material. The server cannot tell real ciphertext from random bytes, so tests use random bytes of the right shape. ---- */
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}
const b64u = (u: Uint8Array) => {
  let s = '';
  for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const rnd = (bytes: number) => b64u(randomBytes(bytes));
/** A well-formed AES-GCM envelope (v1, 96-bit IV, `ctBytes` of ciphertext including the 16-byte tag). */
export const envelope = (ctBytes = 40) => ({ v: 1, iv: rnd(12), ct: rnd(ctBytes) });
export const wrapped = () => envelope(48);
export const kdf = (iterations = 1000) => ({ alg: 'pbkdf2-sha256', iterations, salt: rnd(16) });
/** Shot ciphertext: "BSE" v1 | iv | ct+tag. */
export const shotBlob = (plainLen: number) => {
  const out = new Uint8Array(4 + 12 + plainLen + 16);
  out.set([0x42, 0x53, 0x45, 0x01]);
  out.set(randomBytes(out.length - 4), 4);
  return out;
};

export interface Account {
  token: string; id: string; email: string; authKey: string; recoveryAuth: string; kdf: ReturnType<typeof kdf>;
  wrappedDek: ReturnType<typeof wrapped>; recoveryWrappedDek: ReturnType<typeof wrapped>; status: number;
}
export function signupBody(email = `${uniq()}@example.com`, name = 'Test') {
  return { email, name, authKey: rnd(32), recoveryAuth: rnd(32), kdf: kdf(), wrappedDek: wrapped(), recoveryWrappedDek: wrapped() };
}
export async function signup(email?: string, name?: string): Promise<Account> {
  const body = signupBody(email, name);
  const r = await api('/v1/auth/signup', { method: 'POST', json: body });
  const j = (await r.json()) as { token: string; user: { id: string } };
  return { ...body, token: j.token, id: j.user.id, status: r.status };
}
