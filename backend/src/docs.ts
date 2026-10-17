import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from './auth';
import { ApiError, MAX_DOCS_PER_USER, MAX_DOC_BYTES, type AppEnv, type Ctx } from './util';
import { parseJson, readBody } from './validate';

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ID = /^[A-Za-z0-9_.-]{1,128}$/;
const JsonObject = z.record(z.string(), z.unknown());

function key(c: Ctx) {
  const collection = c.req.param('collection')!, id = c.req.param('id')!;
  if (!NAME.test(collection)) throw new ApiError(422, 'validation_failed', 'collection: invalid name');
  if (!ID.test(id)) throw new ApiError(422, 'validation_failed', 'id: invalid');
  return { collection, id };
}

/** Writes (upsert / tombstone) bump the user's seq and stamp the doc with it, in one D1 batch (a transaction). */
async function writeDoc(c: Ctx, collection: string, id: string, data: object | null) {
  const uid = c.get('userId');
  const now = new Date().toISOString();
  const res = await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET seq = seq + 1 WHERE id = ?').bind(uid),
    c.env.DB.prepare(
      `INSERT INTO docs(user_id,collection,id,data,deleted,updated_at,seq)
       VALUES(?1,?2,?3,?4,?5,?6,(SELECT seq FROM users WHERE id=?1))
       ON CONFLICT(user_id,collection,id) DO UPDATE SET
         data=excluded.data, deleted=excluded.deleted, updated_at=excluded.updated_at, seq=excluded.seq`
    ).bind(uid, collection, id, data === null ? null : JSON.stringify(data), data === null ? 1 : 0, now),
    c.env.DB.prepare('SELECT seq FROM users WHERE id=?').bind(uid)
  ]);
  const seq = (res[2].results[0] as { seq: number }).seq;
  return { collection, id, updatedAt: now, seq };
}

async function existing(c: Ctx, collection: string, id: string) {
  return c.env.DB.prepare('SELECT data, deleted FROM docs WHERE user_id=? AND collection=? AND id=?')
    .bind(c.get('userId'), collection, id).first<{ data: string | null; deleted: number }>();
}

async function checkQuota(c: Ctx, isNew: boolean) {
  if (!isNew) return;
  const r = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM docs WHERE user_id=? AND deleted=0').bind(c.get('userId')).first<{ n: number }>();
  if ((r?.n ?? 0) >= MAX_DOCS_PER_USER) throw new ApiError(409, 'quota_exceeded', `Document limit (${MAX_DOCS_PER_USER}) reached`);
}

export const docs = new Hono<AppEnv>();
docs.use('/docs/*', requireAuth);
docs.use('/sync', requireAuth);

docs.get('/docs/:collection/:id', async c => {
  const { collection, id } = key(c);
  const row = await c.env.DB.prepare('SELECT data, updated_at, seq, deleted FROM docs WHERE user_id=? AND collection=? AND id=?')
    .bind(c.get('userId'), collection, id).first<{ data: string; updated_at: string; seq: number; deleted: number }>();
  if (!row || row.deleted) throw new ApiError(404, 'not_found', 'Document not found');
  return c.json({ collection, id, data: JSON.parse(row.data), updatedAt: row.updated_at, seq: row.seq });
});

/** Replace (create or overwrite). Last write wins. */
docs.put('/docs/:collection/:id', async c => {
  const { collection, id } = key(c);
  const data = await parseJson(c, JsonObject, MAX_DOC_BYTES);
  const prev = await existing(c, collection, id);
  await checkQuota(c, !prev || !!prev.deleted);
  return c.json(await writeDoc(c, collection, id, data));
});

/** Shallow merge into an existing doc (top-level keys replaced; null stores null). 404 if the doc does not exist. */
docs.patch('/docs/:collection/:id', async c => {
  const { collection, id } = key(c);
  const patch = await parseJson(c, JsonObject, MAX_DOC_BYTES);
  const prev = await existing(c, collection, id);
  if (!prev || prev.deleted || prev.data === null) throw new ApiError(404, 'not_found', 'Document not found');
  const merged = { ...JSON.parse(prev.data), ...patch };
  if (new TextEncoder().encode(JSON.stringify(merged)).length > MAX_DOC_BYTES) throw new ApiError(413, 'too_large', 'Merged document too large');
  return c.json(await writeDoc(c, collection, id, merged));
});

/** Delete leaves a tombstone so other devices learn about it. Idempotent. */
docs.delete('/docs/:collection/:id', async c => {
  const { collection, id } = key(c);
  const prev = await existing(c, collection, id);
  if (!prev || prev.deleted) return c.body(null, 204);
  await writeDoc(c, collection, id, null);
  return c.body(null, 204);
});

/**
 * Change feed. `since` is the last seq the client has seen (0 = everything). Results are ordered by seq;
 * `cursor` is the value to pass next time; `hasMore` means call again immediately.
 * A full sync (since=0) omits tombstones.
 */
const SyncQuery = z.object({
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  collection: z.string().regex(NAME).optional()
});
docs.get('/sync', async c => {
  const q = SyncQuery.safeParse(c.req.query());
  if (!q.success) throw new ApiError(422, 'validation_failed', `${q.error.issues[0].path.join('.')}: ${q.error.issues[0].message}`);
  const { since, limit, collection } = q.data;
  const uid = c.get('userId');
  const sql = `SELECT collection,id,data,deleted,updated_at,seq FROM docs WHERE user_id=?1 AND seq>?2
    ${collection ? 'AND collection=?4' : ''} ${since === 0 ? 'AND deleted=0' : ''} ORDER BY seq LIMIT ?3`;
  const binds: unknown[] = [uid, since, limit + 1];
  if (collection) binds.push(collection);
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all<{ collection: string; id: string; data: string | null; deleted: number; updated_at: string; seq: number }>();
  const hasMore = results.length > limit;
  const page = hasMore ? results.slice(0, limit) : results;
  let cursor = since;
  if (page.length) cursor = page[page.length - 1].seq;
  else if (since === 0) cursor = 0;
  // Nothing more to read: advance to the user's head so empty polls stay cheap and tombstone-only gaps are skipped.
  if (!hasMore && !collection) {
    const head = await c.env.DB.prepare('SELECT seq FROM users WHERE id=?').bind(uid).first<{ seq: number }>();
    cursor = Math.max(cursor, head?.seq ?? 0);
  }
  return c.json({
    docs: page.map(r => ({
      collection: r.collection, id: r.id, deleted: !!r.deleted,
      data: r.data === null ? null : JSON.parse(r.data), updatedAt: r.updated_at, seq: r.seq
    })),
    cursor, hasMore
  });
});
