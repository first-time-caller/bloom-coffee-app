import type { Context } from 'hono';

export type Bindings = { DB: D1Database; ALLOWED_ORIGINS?: string; AUTH_RATE_LIMIT?: string };
export type Vars = { userId: string; tokenHash: string };
export type AppEnv = { Bindings: Bindings; Variables: Vars };
export type Ctx = Context<AppEnv>;

export class ApiError extends Error {
  constructor(public status: 400 | 401 | 404 | 409 | 413 | 415 | 422 | 429 | 500, public code: string, message: string) {
    super(message);
  }
}

export const MAX_DOC_BYTES = 256 * 1024;
export const MAX_SHOT_BYTES = 1024 * 1024;
export const MAX_DOCS_PER_USER = 20000;
export const MAX_SHOTS_PER_USER = 5000;

const enc = new TextEncoder();
export const b64 = (buf: ArrayBuffer | Uint8Array) => {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
};
export const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
export const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
export const randomToken = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
export const b64url = (u: Uint8Array) => b64(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const sha256hex = async (s: string) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
