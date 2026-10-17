/**
 * Shapes of everything the client encrypts. The server cannot decrypt any of it; it can only check that what it is
 * handed LOOKS like ciphertext so that a buggy or old client cannot store plaintext by accident.
 */
import { z } from 'zod';
import { ApiError, DEFAULT_KDF_ITERATIONS, type Ctx } from './util';

const B64U = /^[A-Za-z0-9_-]+$/;
const b64uLen = (bytes: number) => Math.ceil((bytes * 4) / 3);

/** AES-256-GCM envelope: 96-bit IV, ciphertext with 128-bit tag. Version 1 is the only one accepted so far. */
export const Envelope = z.object({
  v: z.literal(1),
  iv: z.string().length(b64uLen(12)).regex(B64U),
  ct: z.string().min(b64uLen(17)).regex(B64U) // at least 1 byte of ciphertext + the 16-byte tag
}).strict();

/** The wrapped data key is a 32-byte key plus the tag, so its length is exact. */
export const WrappedKey = z.object({
  v: z.literal(1),
  iv: z.string().length(b64uLen(12)).regex(B64U),
  ct: z.string().length(b64uLen(48)).regex(B64U)
}).strict();

export const AuthSecret = z.string().length(b64uLen(32)).regex(B64U); // authKey / recoveryAuth: 256 bits, base64url

export function kdfSchema(c: Ctx) {
  const min = Number(c.env.MIN_KDF_ITERATIONS) || DEFAULT_KDF_ITERATIONS;
  return z.object({
    alg: z.literal('pbkdf2-sha256'),
    iterations: z.number().int().min(min).max(10_000_000),
    salt: z.string().min(b64uLen(16)).max(b64uLen(64)).regex(B64U)
  }).strict();
}

export type EnvelopeT = z.infer<typeof Envelope>;

/** Shots are binary: "BSE" + version byte 1, 12-byte IV, then ciphertext + 16-byte tag. */
export const SHOT_MAGIC = [0x42, 0x53, 0x45, 0x01];
export const SHOT_OVERHEAD = SHOT_MAGIC.length + 12 + 16;

export function assertShotCiphertext(bytes: Uint8Array) {
  if (bytes.length < SHOT_OVERHEAD + 1 || SHOT_MAGIC.some((b, i) => bytes[i] !== b))
    throw new ApiError(422, 'validation_failed', 'Shot body must be an encrypted Bloom shot (BSE v1)');
}
