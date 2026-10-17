import type { z } from 'zod';
import { ApiError, type Ctx } from './util';

/** Read a bounded text body (checked on the actual bytes, not just Content-Length). */
export async function readBody(c: Ctx, maxBytes: number): Promise<ArrayBuffer> {
  const cl = Number(c.req.header('Content-Length'));
  if (Number.isFinite(cl) && cl > maxBytes) throw new ApiError(413, 'too_large', `Body exceeds ${maxBytes} bytes`);
  const reader = c.req.raw.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { reader.cancel().catch(() => {}); throw new ApiError(413, 'too_large', `Body exceeds ${maxBytes} bytes`); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const ch of chunks) { out.set(ch, o); o += ch.byteLength; }
  return out.buffer;
}

export async function parseJson<T extends z.ZodTypeAny>(c: Ctx, schema: T, maxBytes: number): Promise<z.infer<T>> {
  const buf = await readBody(c, maxBytes);
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder().decode(buf)); }
  catch { throw new ApiError(400, 'invalid_json', 'Body must be valid JSON'); }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new ApiError(422, 'validation_failed', `${i.path.join('.') || 'body'}: ${i.message}`);
  }
  return r.data;
}
