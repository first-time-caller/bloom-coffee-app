import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from './auth';
import { ApiError, MAX_SHOTS_PER_USER, MAX_SHOT_BYTES, type AppEnv, type Ctx } from './util';
import { readBody } from './validate';

const ID = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_META_BYTES = 8 * 1024;

function ids(c: Ctx) {
  const machineId = c.req.param('machineId')!, shotId = c.req.param('shotId')!;
  if (!ID.test(machineId) || !ID.test(shotId)) throw new ApiError(422, 'validation_failed', 'machineId/shotId: invalid');
  return { machineId, shotId };
}

export const shots = new Hono<AppEnv>();
shots.use('/shots', requireAuth);
shots.use('/shots/*', requireAuth);

/** Body = raw .slog bytes. Optional `X-Shot-Meta` header: JSON object (<= 8 KB) with a parsed summary. Idempotent upsert. */
shots.put('/shots/:machineId/:shotId', async c => {
  const { machineId, shotId } = ids(c);
  const ct = (c.req.header('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  if (ct !== 'application/octet-stream') throw new ApiError(415, 'unsupported_media_type', 'Content-Type must be application/octet-stream');
  let meta: string | null = null;
  const mh = c.req.header('X-Shot-Meta');
  if (mh) {
    if (mh.length > MAX_META_BYTES) throw new ApiError(413, 'too_large', 'X-Shot-Meta too large');
    try {
      const parsed = z.record(z.string(), z.unknown()).parse(JSON.parse(mh));
      meta = JSON.stringify(parsed);
    } catch { throw new ApiError(422, 'validation_failed', 'X-Shot-Meta must be a JSON object'); }
  }
  const body = await readBody(c, MAX_SHOT_BYTES);
  if (body.byteLength === 0) throw new ApiError(422, 'validation_failed', 'Empty body');
  const uid = c.get('userId');
  const prev = await c.env.DB.prepare('SELECT 1 AS x FROM shots WHERE user_id=? AND machine_id=? AND shot_id=?').bind(uid, machineId, shotId).first();
  if (!prev) {
    const n = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM shots WHERE user_id=?').bind(uid).first<{ n: number }>();
    if ((n?.n ?? 0) >= MAX_SHOTS_PER_USER) throw new ApiError(409, 'quota_exceeded', `Shot limit (${MAX_SHOTS_PER_USER}) reached`);
  }
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO shots(user_id,machine_id,shot_id,data,size,meta,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?7)
     ON CONFLICT(user_id,machine_id,shot_id) DO UPDATE SET data=excluded.data,size=excluded.size,meta=COALESCE(excluded.meta,meta),updated_at=excluded.updated_at`
  ).bind(uid, machineId, shotId, body, body.byteLength, meta, now).run();
  return c.json({ machineId, shotId, size: body.byteLength, updatedAt: now }, prev ? 200 : 201);
});

/** Metadata only. Optional ?machineId= filter, ?limit= (default 100, max 500), ?before=<updatedAt> for paging. */
shots.get('/shots', async c => {
  const q = z.object({
    machineId: z.string().regex(ID).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    before: z.string().max(40).optional()
  }).safeParse(c.req.query());
  if (!q.success) throw new ApiError(422, 'validation_failed', `${q.error.issues[0].path.join('.')}: ${q.error.issues[0].message}`);
  const { machineId, limit, before } = q.data;
  const binds: unknown[] = [c.get('userId')];
  let where = 'user_id=?1';
  if (machineId) { binds.push(machineId); where += ` AND machine_id=?${binds.length}`; }
  if (before) { binds.push(before); where += ` AND updated_at<?${binds.length}`; }
  binds.push(limit);
  const { results } = await c.env.DB.prepare(
    `SELECT machine_id,shot_id,size,meta,created_at,updated_at FROM shots WHERE ${where} ORDER BY updated_at DESC LIMIT ?${binds.length}`
  ).bind(...binds).all<{ machine_id: string; shot_id: string; size: number; meta: string | null; created_at: string; updated_at: string }>();
  return c.json({
    shots: results.map(r => ({
      machineId: r.machine_id, shotId: r.shot_id, size: r.size, meta: r.meta ? JSON.parse(r.meta) : null,
      createdAt: r.created_at, updatedAt: r.updated_at
    }))
  });
});

shots.get('/shots/:machineId/:shotId', async c => {
  const { machineId, shotId } = ids(c);
  const row = await c.env.DB.prepare('SELECT data, meta FROM shots WHERE user_id=? AND machine_id=? AND shot_id=?')
    .bind(c.get('userId'), machineId, shotId).first<{ data: ArrayBuffer | number[]; meta: string | null }>();
  if (!row) throw new ApiError(404, 'not_found', 'Shot not found');
  const bytes = row.data instanceof ArrayBuffer ? new Uint8Array(row.data) : new Uint8Array(row.data);
  const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, no-store' };
  if (row.meta) headers['X-Shot-Meta'] = row.meta;
  return new Response(bytes, { headers });
});

shots.delete('/shots/:machineId/:shotId', async c => {
  const { machineId, shotId } = ids(c);
  await c.env.DB.prepare('DELETE FROM shots WHERE user_id=? AND machine_id=? AND shot_id=?').bind(c.get('userId'), machineId, shotId).run();
  return c.body(null, 204);
});
