import { b64, unb64, timingSafeEqual } from './util';

/** Workers' WebCrypto caps PBKDF2 at 100,000 iterations, so that is what we use. The count is stored per hash. */
export const PBKDF2_ITERATIONS = 100_000;
const enc = new TextEncoder();

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const h = await derive(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(h)}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  // With no stored hash (unknown email) still burn the same CPU so timing does not reveal account existence.
  const parts = (stored ?? '').split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2') {
    await derive(password, new Uint8Array(16), PBKDF2_ITERATIONS);
    return false;
  }
  const iterations = Math.min(Number(parts[2]) || PBKDF2_ITERATIONS, PBKDF2_ITERATIONS);
  const h = await derive(password, unb64(parts[3]), iterations);
  return timingSafeEqual(h, unb64(parts[4]));
}
