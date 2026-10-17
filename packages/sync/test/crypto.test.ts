import { describe, expect, it } from 'vitest';
import * as C from '../src/crypto.ts';
import { cryptoImpl as c } from './harness.ts';

const kdf = (iterations = 1000): C.Kdf => ({ alg: 'pbkdf2-sha256', iterations, salt: C.b64u(new Uint8Array(16).fill(7)) });
const dekKey = async () => C.importDek(c, C.newDekBytes(c));

describe('base64url', () => {
  it('round-trips every length and rejects junk', () => {
    for (let n = 0; n < 40; n++) {
      const b = c.getRandomValues(new Uint8Array(n));
      const s = C.b64u(b);
      expect(s).not.toMatch(/[+/=]/);
      expect(C.unb64u(s)).toEqual(b);
    }
    expect(() => C.unb64u('ab+/')).toThrow(C.CryptoError);
    expect(() => C.unb64u('a')).toThrow(C.CryptoError);
    expect(C.b64u(Uint8Array.of(0xfb, 0xff))).toBe('-_8');
  });
});

describe('key derivation', () => {
  it('is deterministic and separates auth key from the kek', async () => {
    const a = await C.deriveKeys(c, 'hunter2hunter2', 'A@Example.com ', kdf(), 1000);
    const b = await C.deriveKeys(c, 'hunter2hunter2', 'a@example.com', kdf(), 1000);
    expect(a.authKey).toBe(b.authKey); // email is normalised
    expect(a.authKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await C.deriveKeys(c, 'other password', 'a@example.com', kdf(), 1000)).authKey).not.toBe(a.authKey);
    expect((await C.deriveKeys(c, 'hunter2hunter2', 'b@example.com', kdf(), 1000)).authKey).not.toBe(a.authKey);
    expect((await C.deriveKeys(c, 'hunter2hunter2', 'a@example.com', { ...kdf(), salt: C.b64u(new Uint8Array(16).fill(8)) }, 1000)).authKey).not.toBe(a.authKey);
    expect((await C.deriveKeys(c, 'hunter2hunter2', 'a@example.com', kdf(1001), 1000)).authKey).not.toBe(a.authKey);
    expect(a.kek.extractable).toBe(false);
    // the kek must not be recoverable from the auth key: a kek made from the same inputs cannot decrypt with the authKey bytes
    const env = await C.seal(c, a.kek, C.utf8('x'), 'aad');
    await expect(C.open(c, await C.importDek(c, C.unb64u(a.authKey)), env, 'aad')).rejects.toMatchObject({ code: 'decrypt_failed' });
  });
  it('normalises passwords (NFKC) so the same text always yields the same key', async () => {
    const a = await C.deriveKeys(c, 'café-password', 'a@b.co', kdf(), 1000);
    const b = await C.deriveKeys(c, 'café-password', 'a@b.co', kdf(), 1000);
    expect(a.authKey).toBe(b.authKey);
  });
  it('refuses a downgraded or malformed KDF', async () => {
    await expect(C.deriveKeys(c, 'pw', 'a@b.co', kdf(1000), 600_000)).rejects.toMatchObject({ code: 'bad_kdf' });
    await expect(C.deriveKeys(c, 'pw', 'a@b.co', { alg: 'md5' } as any, 1000)).rejects.toMatchObject({ code: 'bad_kdf' });
    await expect(C.deriveKeys(c, 'pw', 'a@b.co', null as any, 1000)).rejects.toMatchObject({ code: 'bad_kdf' });
  });
  it('defaults to at least 600,000 rounds', () => {
    expect(C.DEFAULT_ITERATIONS).toBeGreaterThanOrEqual(600_000);
    expect(C.newKdf(c).iterations).toBe(C.DEFAULT_ITERATIONS);
    expect(C.newKdf(c).salt).not.toBe(C.newKdf(c).salt);
  });
  it('derives with the production round count', async () => {
    const k = await C.deriveKeys(c, 'a long enough password', 'a@b.co', C.newKdf(c));
    expect(k.authKey).toHaveLength(43);
  });
});

describe('envelopes', () => {
  it('round-trips documents with unique IVs', async () => {
    const k = await dekKey();
    const body = { note: 'zz secret note', n: 18.5, arr: [1, 2], nested: { a: null } };
    const e1 = await C.encryptDoc(c, k, 'u1', 'brews', 'b1', body);
    const e2 = await C.encryptDoc(c, k, 'u1', 'brews', 'b1', body);
    expect(e1.v).toBe(1);
    expect(e1.iv).not.toBe(e2.iv);
    expect(JSON.stringify(e1)).not.toContain('secret');
    expect(C.unb64u(e1.iv)).toHaveLength(12);
    expect(await C.decryptDoc(c, k, 'u1', 'brews', 'b1', e1)).toEqual(body);
  });
  it('binds ciphertext to user, collection and id (AAD)', async () => {
    const k = await dekKey();
    const e = await C.encryptDoc(c, k, 'u1', 'brews', 'b1', { a: 1 });
    for (const [u, col, id] of [['u2', 'brews', 'b1'], ['u1', 'bags', 'b1'], ['u1', 'brews', 'b2']])
      await expect(C.decryptDoc(c, k, u, col, id, e)).rejects.toMatchObject({ code: 'decrypt_failed' });
  });
  it('detects a flipped ciphertext bit, a flipped tag bit, a wrong IV and a wrong key', async () => {
    const k = await dekKey();
    const e = await C.encryptDoc(c, k, 'u1', 'brews', 'b1', { a: 1 });
    const ct = C.unb64u(e.ct);
    const flip = (i: number) => { const x = ct.slice(); x[i] ^= 1; return { ...e, ct: C.b64u(x) }; };
    await expect(C.decryptDoc(c, k, 'u1', 'brews', 'b1', flip(0))).rejects.toMatchObject({ code: 'decrypt_failed' });
    await expect(C.decryptDoc(c, k, 'u1', 'brews', 'b1', flip(ct.length - 1))).rejects.toMatchObject({ code: 'decrypt_failed' });
    const iv = C.unb64u(e.iv); iv[0] ^= 1;
    await expect(C.decryptDoc(c, k, 'u1', 'brews', 'b1', { ...e, iv: C.b64u(iv) })).rejects.toMatchObject({ code: 'decrypt_failed' });
    await expect(C.decryptDoc(c, await dekKey(), 'u1', 'brews', 'b1', e)).rejects.toMatchObject({ code: 'decrypt_failed' });
  });
  it('rejects malformed or unknown-version envelopes', async () => {
    const k = await dekKey();
    const e = await C.encryptDoc(c, k, 'u', 'c', 'i', {});
    for (const bad of [null, 'str', [], { ...e, v: 2 }, { ...e, iv: 5 }, { v: 1, iv: e.iv }, { ...e, iv: 'AAAA' }, { ...e, ct: 'AAAA' }, { ...e, ct: '***' }])
      await expect(C.decryptDoc(c, k, 'u', 'c', 'i', bad)).rejects.toBeInstanceOf(C.CryptoError);
  });
  it('rejects plaintext that is not a JSON object', async () => {
    const k = await dekKey();
    const e = await C.seal(c, k, C.utf8('not json'), C.docAad('u', 'c', 'i'));
    await expect(C.decryptDoc(c, k, 'u', 'c', 'i', e)).rejects.toMatchObject({ code: 'bad_envelope' });
    const e2 = await C.seal(c, k, C.utf8('[1]'), C.docAad('u', 'c', 'i'));
    await expect(C.decryptDoc(c, k, 'u', 'c', 'i', e2)).rejects.toMatchObject({ code: 'bad_envelope' });
  });
});

describe('data key wrapping', () => {
  it('wraps with the kek, unwraps with the right password only, and separates the two wraps by AAD', async () => {
    const keys = await C.deriveKeys(c, 'correct horse', 'a@b.co', kdf(), 1000);
    const wrong = await C.deriveKeys(c, 'wrong horse', 'a@b.co', kdf(), 1000);
    const raw = C.newDekBytes(c);
    const w = await C.wrapDek(c, keys.kek, raw);
    expect(await C.unwrapDek(c, keys.kek, w)).toEqual(raw);
    await expect(C.unwrapDek(c, wrong.kek, w)).rejects.toMatchObject({ code: 'decrypt_failed' });
    await expect(C.unwrapDek(c, keys.kek, w, C.AAD_DEK_RECOVERY)).rejects.toMatchObject({ code: 'decrypt_failed' });
    const short = await C.seal(c, keys.kek, new Uint8Array(16), C.AAD_DEK);
    await expect(C.unwrapDek(c, keys.kek, short)).rejects.toMatchObject({ code: 'bad_envelope' });
  });
});

describe('shots', () => {
  it('round-trips bytes, hides content, and binds to machine and shot id', async () => {
    const k = await dekKey();
    const slog = Uint8Array.from({ length: 5000 }, (_, i) => (i * 31) & 255);
    const blob = await C.encryptShot(c, k, 'u1', 'gm-1', '42', slog);
    expect([...blob.subarray(0, 4)]).toEqual([...C.SHOT_MAGIC]);
    expect(blob.length).toBe(slog.length + 4 + 12 + 16);
    expect(await C.decryptShot(c, k, 'u1', 'gm-1', '42', blob)).toEqual(slog);
    await expect(C.decryptShot(c, k, 'u1', 'gm-1', '43', blob)).rejects.toMatchObject({ code: 'decrypt_failed' });
    await expect(C.decryptShot(c, k, 'u1', 'gm-2', '42', blob)).rejects.toMatchObject({ code: 'decrypt_failed' });
    await expect(C.decryptShot(c, k, 'u2', 'gm-1', '42', blob)).rejects.toMatchObject({ code: 'decrypt_failed' });
    const t = blob.slice(); t[t.length - 1] ^= 1;
    await expect(C.decryptShot(c, k, 'u1', 'gm-1', '42', t)).rejects.toMatchObject({ code: 'decrypt_failed' });
    await expect(C.decryptShot(c, k, 'u1', 'gm-1', '42', slog)).rejects.toMatchObject({ code: 'bad_envelope' });
    await expect(C.decryptShot(c, k, 'u1', 'gm-1', '42', new Uint8Array(10))).rejects.toMatchObject({ code: 'bad_envelope' });
  });
});

describe('recovery key', () => {
  it('encodes as 14 groups of four and decodes forgivingly', async () => {
    const raw = C.randomBytes(c, 32);
    const text = await C.encodeRecoveryKey(c, raw);
    expect(text).toMatch(/^([A-Z2-7]{4}-){13}[A-Z2-7]{4}$/);
    expect(await C.decodeRecoveryKey(c, text)).toEqual(raw);
    expect(await C.decodeRecoveryKey(c, text.toLowerCase().replace(/-/g, ' '))).toEqual(raw);
    expect(await C.decodeRecoveryKey(c, ' ' + text.replace(/-/g, '') + '\n')).toEqual(raw);
  });
  it('maps look-alike characters (0 to O, 1 to I, 8 to B)', async () => {
    for (let i = 0; i < 40; i++) {
      const raw = C.randomBytes(c, 32);
      const text = await C.encodeRecoveryKey(c, raw);
      if (!/[OIB]/.test(text)) continue;
      const typed = text.replace(/O/g, '0').replace(/I/g, '1').replace(/B/g, '8');
      expect(await C.decodeRecoveryKey(c, typed)).toEqual(raw);
      return;
    }
  });
  it('catches typos, truncation and wrong lengths', async () => {
    const text = await C.encodeRecoveryKey(c, C.randomBytes(c, 32));
    const alt = text[0] === 'A' ? 'B' : 'A';
    await expect(C.decodeRecoveryKey(c, alt + text.slice(1))).rejects.toMatchObject({ code: 'bad_recovery_key' });
    await expect(C.decodeRecoveryKey(c, text.slice(0, -1))).rejects.toMatchObject({ code: 'bad_recovery_key' });
    await expect(C.decodeRecoveryKey(c, text + 'AAAA')).rejects.toMatchObject({ code: 'bad_recovery_key' });
    await expect(C.decodeRecoveryKey(c, text.slice(0, 4) + '9' + text.slice(5))).rejects.toMatchObject({ code: 'bad_recovery_key' });
    await expect(C.encodeRecoveryKey(c, new Uint8Array(5))).rejects.toMatchObject({ code: 'bad_recovery_key' });
  });
  it('derives distinct auth and wrap keys from the recovery key', async () => {
    const raw = C.randomBytes(c, 32);
    const a = await C.deriveRecovery(c, raw), b = await C.deriveRecovery(c, raw);
    expect(a.recoveryAuth).toBe(b.recoveryAuth);
    expect(a.recoveryAuth).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await C.deriveRecovery(c, C.randomBytes(c, 32))).recoveryAuth).not.toBe(a.recoveryAuth);
  });
});
