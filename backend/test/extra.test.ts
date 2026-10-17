/** Extra coverage added with the reliability gate: utility units, shot delete, orphaned-session handling. */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { api, shotBlob, signup } from './helpers';
import { b64, unb64, b64url, randomToken, sha256hex, timingSafeEqual } from '../src/util';

describe('util', () => {
  it('round-trips base64 and produces url-safe tokens', () => {
    const u = Uint8Array.from([0, 255, 250, 251, 62, 63]);
    expect(unb64(b64(u))).toEqual(u);
    expect(b64(u.buffer)).toBe(b64(u));
    expect(b64url(u)).not.toMatch(/[+/=]/);
    expect(randomToken(16)).not.toBe(randomToken(16));
    expect(randomToken().length).toBeGreaterThan(40);
  });
  it('hashes sha256 to hex', async () => {
    expect(await sha256hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('compares in constant-time shape, including different lengths', () => {
    expect(timingSafeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
    expect(timingSafeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
    expect(timingSafeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2, 0))).toBe(false);
    expect(timingSafeEqual(Uint8Array.of(), Uint8Array.of(0))).toBe(false);
  });
});

describe('edge routes', () => {
  it('serves the health route with security headers', async () => {
    const r = await api('/');
    expect(r.status).toBe(200);
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(r.headers.get('Cache-Control')).toBe('no-store');
  });
  it('rejects /v1/me for a user deleted after sign-in', async () => {
    const u = await signup();
    await env.DB.prepare('PRAGMA foreign_keys = OFF').run();
    await env.DB.prepare('DELETE FROM users WHERE id=?').bind(u.id).run();
    expect((await api('/v1/me', { token: u.token })).status).toBe(401);
  });
  it('deletes a shot and then 404s', async () => {
    const u = await signup();
    const body = shotBlob(3);
    await api('/v1/shots/gm/7', { method: 'PUT', token: u.token, body, headers: { 'Content-Type': 'application/octet-stream' } });
    expect((await api('/v1/shots/gm/7', { method: 'DELETE', token: u.token })).status).toBe(204);
    expect((await api('/v1/shots/gm/7', { token: u.token })).status).toBe(404);
  });
});
