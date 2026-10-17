/**
 * Bloom end-to-end encryption primitives. WebCrypto only, no third-party crypto.
 *
 * Key hierarchy (all formats versioned so algorithms can be rotated):
 *
 *   password --PBKDF2-SHA256(salt = "bloom-kdf-v1|" + email + "|" + serverSalt, >= 600k iterations)--> masterKey
 *   masterKey --HKDF-SHA256(info "bloom/auth/v1")--> authKey   (sent to the server in place of the password)
 *   masterKey --HKDF-SHA256(info "bloom/kek/v1")---> kek       (AES-256-GCM key, never leaves the device)
 *   dek = 256 random bits; wrappedDek = AES-GCM(kek, dek); recoveryWrappedDek = AES-GCM(recoveryKek, dek)
 *   recoveryKey = 256 random bits (shown once as base32); recoveryKek / recoveryAuth derived with HKDF
 *   doc body  = AES-256-GCM(dek, iv96, json, AAD = "userId|collection|docId|v1")  -> { v, iv, ct }
 *   shot body = "BSE\x01" | iv96 | AES-256-GCM(dek, .slog bytes, AAD = "userId|shots/machineId|shotId|v1")
 */

export interface CryptoLike {
  subtle: SubtleCrypto;
  getRandomValues<T extends ArrayBufferView | null>(array: T): T;
}

export class CryptoError extends Error {
  constructor(public code: 'bad_envelope' | 'decrypt_failed' | 'bad_recovery_key' | 'bad_kdf', message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

export const KDF_ALG = 'pbkdf2-sha256';
export const DEFAULT_ITERATIONS = 600_000;
export const MIN_ITERATIONS = 600_000;
export const ENVELOPE_VERSION = 1;
export const SHOT_MAGIC = Uint8Array.of(0x42, 0x53, 0x45, 0x01); // "BSE" + version 1
export const IV_BYTES = 12;
export const TAG_BYTES = 16;

export interface Kdf { alg: typeof KDF_ALG; iterations: number; salt: string }
export interface Envelope { v: number; iv: string; ct: string }

const enc = new TextEncoder();
const dec = new TextDecoder();
export const utf8 = (s: string): Uint8Array<ArrayBuffer> => enc.encode(s) as Uint8Array<ArrayBuffer>;
export const fromUtf8 = (b: Uint8Array): string => dec.decode(b);

/* ---------- base64url (own implementation: no btoa/atob dependency, works in Hermes) ---------- */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_REV: Record<string, number> = {};
for (let i = 0; i < B64.length; i++) B64_REV[B64[i]] = i;

export function b64u(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i + 1 === bytes.length) {
    const n = bytes[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
  } else if (i + 2 === bytes.length) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63];
  }
  return out;
}

export function unb64u(s: string): Uint8Array<ArrayBuffer> {
  if (typeof s !== 'string' || /[^A-Za-z0-9_-]/.test(s) || s.length % 4 === 1) throw new CryptoError('bad_envelope', 'Invalid base64url');
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const a = B64_REV[s[i]], b = B64_REV[s[i + 1]], c = i + 2 < s.length ? B64_REV[s[i + 2]] : 0, d = i + 3 < s.length ? B64_REV[s[i + 3]] : 0;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    out[o++] = (n >> 16) & 255;
    if (i + 2 < s.length) out[o++] = (n >> 8) & 255;
    if (i + 3 < s.length) out[o++] = n & 255;
  }
  return out;
}

export function randomBytes(c: CryptoLike, n: number): Uint8Array<ArrayBuffer> {
  return c.getRandomValues(new Uint8Array(n));
}

/** Email as used in the KDF salt: trimmed, lower-cased, NFKC. The server applies the same normalisation. */
export const normalizeEmail = (email: string) => String(email).normalize('NFKC').trim().toLowerCase();

/* ---------- key derivation ---------- */
export interface DerivedKeys { authKey: string; kek: CryptoKey }

export function newKdf(c: CryptoLike, iterations = DEFAULT_ITERATIONS): Kdf {
  return { alg: KDF_ALG, iterations, salt: b64u(randomBytes(c, 16)) };
}

const HKDF_SALT = utf8('bloom-hkdf-salt-v1');
const hkdfBits = (c: CryptoLike, key: CryptoKey, info: string) =>
  c.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: utf8(info) }, key, 256).then(b => new Uint8Array(b));
const hkdfAesKey = (c: CryptoLike, key: CryptoKey, info: string) =>
  c.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: utf8(info) }, key, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

export function checkKdf(kdf: unknown): asserts kdf is Kdf {
  const k = kdf as Kdf;
  if (!k || k.alg !== KDF_ALG || !Number.isInteger(k.iterations) || k.iterations < 1 || typeof k.salt !== 'string' || !k.salt)
    throw new CryptoError('bad_kdf', 'Unsupported key derivation parameters');
}

export async function deriveKeys(c: CryptoLike, password: string, email: string, kdf: Kdf, minIterations = MIN_ITERATIONS): Promise<DerivedKeys> {
  checkKdf(kdf);
  // Never derive with fewer rounds than the floor: a malicious server could otherwise downgrade the KDF.
  if (kdf.iterations < minIterations) throw new CryptoError('bad_kdf', 'Server asked for too few key-derivation rounds');
  const salt = new Uint8Array([...utf8('bloom-kdf-v1|' + normalizeEmail(email) + '|'), ...unb64u(kdf.salt)]);
  const pw = await c.subtle.importKey('raw', utf8(String(password).normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const master = new Uint8Array(await c.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: kdf.iterations }, pw, 256));
  const hk = await c.subtle.importKey('raw', master, 'HKDF', false, ['deriveBits', 'deriveKey']);
  master.fill(0);
  return { authKey: b64u(await hkdfBits(c, hk, 'bloom/auth/v1')), kek: await hkdfAesKey(c, hk, 'bloom/kek/v1') };
}

/* ---------- AES-GCM envelope ---------- */
export async function seal(c: CryptoLike, key: CryptoKey, plain: Uint8Array, aad: string): Promise<Envelope> {
  const iv = randomBytes(c, IV_BYTES);
  const ct = new Uint8Array(await c.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(aad), tagLength: 128 }, key, plain as BufferSource));
  return { v: ENVELOPE_VERSION, iv: b64u(iv), ct: b64u(ct) };
}

export function checkEnvelope(e: unknown): asserts e is Envelope {
  const x = e as Envelope;
  if (!x || typeof x !== 'object' || Array.isArray(x) || x.v !== ENVELOPE_VERSION || typeof x.iv !== 'string' || typeof x.ct !== 'string')
    throw new CryptoError('bad_envelope', 'Unrecognised ciphertext format');
}

export async function open(c: CryptoLike, key: CryptoKey, env: unknown, aad: string): Promise<Uint8Array> {
  checkEnvelope(env);
  const iv = unb64u(env.iv), ct = unb64u(env.ct);
  if (iv.length !== IV_BYTES || ct.length < TAG_BYTES) throw new CryptoError('bad_envelope', 'Malformed ciphertext');
  try {
    return new Uint8Array(await c.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: utf8(aad), tagLength: 128 }, key, ct));
  } catch {
    throw new CryptoError('decrypt_failed', 'Could not decrypt (wrong key or data was changed)');
  }
}

/* ---------- data key ---------- */
export const importDek = (c: CryptoLike, raw: Uint8Array) => c.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
export const newDekBytes = (c: CryptoLike) => randomBytes(c, 32);
export const AAD_DEK = 'bloom|dek|v1';
export const AAD_DEK_RECOVERY = 'bloom|dek-recovery|v1';
export const wrapDek = (c: CryptoLike, kek: CryptoKey, rawDek: Uint8Array, aad = AAD_DEK) => seal(c, kek, rawDek, aad);
export async function unwrapDek(c: CryptoLike, kek: CryptoKey, env: unknown, aad = AAD_DEK): Promise<Uint8Array> {
  const raw = await open(c, kek, env, aad);
  if (raw.length !== 32) throw new CryptoError('bad_envelope', 'Unexpected key length');
  return raw;
}

/* ---------- documents and shots ---------- */
export const docAad = (uid: string, col: string, id: string) => `${uid}|${col}|${id}|v1`;
export const shotAad = (uid: string, machineId: string, shotId: string) => `${uid}|shots/${machineId}|${shotId}|v1`;

export const encryptDoc = (c: CryptoLike, dek: CryptoKey, uid: string, col: string, id: string, body: unknown) =>
  seal(c, dek, utf8(JSON.stringify(body)), docAad(uid, col, id));

export async function decryptDoc(c: CryptoLike, dek: CryptoKey, uid: string, col: string, id: string, env: unknown): Promise<Record<string, unknown>> {
  const plain = await open(c, dek, env, docAad(uid, col, id));
  let v: unknown;
  try { v = JSON.parse(fromUtf8(plain)); } catch { throw new CryptoError('bad_envelope', 'Decrypted data is not JSON'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new CryptoError('bad_envelope', 'Decrypted data is not an object');
  return v as Record<string, unknown>;
}

export async function encryptShot(c: CryptoLike, dek: CryptoKey, uid: string, machineId: string, shotId: string, bytes: Uint8Array): Promise<Uint8Array> {
  const e = await seal(c, dek, bytes, shotAad(uid, machineId, shotId));
  const iv = unb64u(e.iv), ct = unb64u(e.ct);
  const out = new Uint8Array(SHOT_MAGIC.length + iv.length + ct.length);
  out.set(SHOT_MAGIC, 0); out.set(iv, SHOT_MAGIC.length); out.set(ct, SHOT_MAGIC.length + iv.length);
  return out;
}

export async function decryptShot(c: CryptoLike, dek: CryptoKey, uid: string, machineId: string, shotId: string, blob: Uint8Array): Promise<Uint8Array> {
  const m = SHOT_MAGIC.length;
  if (blob.length < m + IV_BYTES + TAG_BYTES || SHOT_MAGIC.some((b, i) => blob[i] !== b)) throw new CryptoError('bad_envelope', 'Unrecognised shot format');
  return open(c, dek, { v: ENVELOPE_VERSION, iv: b64u(blob.subarray(m, m + IV_BYTES)), ct: b64u(blob.subarray(m + IV_BYTES)) }, shotAad(uid, machineId, shotId));
}

/* ---------- recovery key ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(bytes: Uint8Array): string {
  let bits = 0, val = 0, out = '';
  for (const b of bytes) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}

function unbase32(s: string): Uint8Array {
  let bits = 0, val = 0;
  const out: number[] = [];
  for (const ch of s) {
    val = (val << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Uint8Array.from(out);
}

const checksum = async (c: CryptoLike, payload: Uint8Array) => new Uint8Array(await c.subtle.digest('SHA-256', payload as BufferSource)).subarray(0, 3);

/** 256 random bits + a 24-bit checksum, as 14 dash-separated groups of four base32 characters. */
export async function encodeRecoveryKey(c: CryptoLike, key: Uint8Array): Promise<string> {
  if (key.length !== 32) throw new CryptoError('bad_recovery_key', 'Recovery key must be 32 bytes');
  const all = new Uint8Array(35); all.set(key, 0); all.set(await checksum(c, key), 32);
  return base32(all).match(/.{4}/g)!.join('-');
}

/** Accepts any case, spaces or dashes, and the usual look-alikes (0 for O, 1 for I, 8 for B). Throws on a typo. */
export async function decodeRecoveryKey(c: CryptoLike, text: string): Promise<Uint8Array> {
  const s = String(text).toUpperCase().replace(/[\s-]+/g, '').replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B');
  if (s.length !== 56 || /[^A-Z2-7]/.test(s)) throw new CryptoError('bad_recovery_key', 'That recovery key is not the right length or has unexpected characters');
  const all = unbase32(s);
  const key = all.subarray(0, 32), sum = await checksum(c, key);
  if (sum[0] !== all[32] || sum[1] !== all[33] || sum[2] !== all[34]) throw new CryptoError('bad_recovery_key', 'That recovery key has a typo. Check it and try again');
  return Uint8Array.from(key);
}

export interface RecoveryKeys { recoveryAuth: string; recoveryKek: CryptoKey }
export async function deriveRecovery(c: CryptoLike, key: Uint8Array): Promise<RecoveryKeys> {
  const hk = await c.subtle.importKey('raw', key as BufferSource, 'HKDF', false, ['deriveBits', 'deriveKey']);
  return { recoveryAuth: b64u(await hkdfBits(c, hk, 'bloom/recovery-auth/v1')), recoveryKek: await hkdfAesKey(c, hk, 'bloom/recovery-kek/v1') };
}
