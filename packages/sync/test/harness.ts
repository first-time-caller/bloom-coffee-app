/** Test harness: fake clock, in-memory storage, fake lifecycle, and an in-memory implementation of the Bloom server protocol. */
import { webcrypto } from 'node:crypto';
import { createSync } from '../src/client.ts';
import type { Clock, Deps, KeyStore, KV, Lifecycle } from '../src/types.ts';

export const subtle = webcrypto.subtle;
export const cryptoImpl = webcrypto as unknown as Deps['crypto'];

export class FakeClock implements Clock {
  t = 1_000_000;
  private id = 1;
  private timers = new Map<number, { at: number; fn: () => void; every?: number }>();
  now() { return this.t; }
  setTimeout(fn: () => void, ms: number) { const id = this.id++; this.timers.set(id, { at: this.t + Math.max(0, ms), fn }); return id; }
  setInterval(fn: () => void, ms: number) { const id = this.id++; this.timers.set(id, { at: this.t + ms, fn, every: ms }); return id; }
  clearTimeout(h: unknown) { this.timers.delete(h as number); }
  clearInterval(h: unknown) { this.timers.delete(h as number); }
  get pendingTimers() { return this.timers.size; }
  /** Advance virtual time, running every due timer in order. Yields to the event loop between timers so async chains progress. */
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void; every?: number }] | null = null;
      for (const e of this.timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      const [id, tm] = next;
      this.t = Math.max(this.t, tm.at);
      if (tm.every) tm.at += tm.every; else this.timers.delete(id);
      tm.fn();
      await idle();
    }
    this.t = end;
    await idle();
  }
}

export const idle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
export async function until(fn: () => boolean, label = 'condition', ms = 8000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + label); await new Promise(r => setTimeout(r, 2)); }
}

export class MemoryKV implements KV {
  m = new Map<string, string>();
  async get(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  async set(k: string, v: string) { this.m.set(k, v); }
  async remove(k: string) { this.m.delete(k); }
}
export class MemoryKeyStore implements KeyStore {
  m = new Map<string, CryptoKey>();
  async save(u: string, k: CryptoKey) { this.m.set(u, k); }
  async load(u: string) { return this.m.get(u) ?? null; }
  async clear(u: string) { this.m.delete(u); }
}
export class FakeLifecycle implements Lifecycle {
  visible = true;
  online = new Set<() => void>(); vis = new Set<() => void>(); hide = new Set<() => void>();
  isVisible() { return this.visible; }
  onOnline(cb: () => void) { this.online.add(cb); return () => void this.online.delete(cb); }
  onVisible(cb: () => void) { this.vis.add(cb); return () => void this.vis.delete(cb); }
  onHide(cb: () => void) { this.hide.add(cb); return () => void this.hide.delete(cb); }
  fireOnline() { this.online.forEach(f => f()); }
  fireVisible() { this.vis.forEach(f => f()); }
  fireHide() { this.hide.forEach(f => f()); }
}

/* ------------------------------------------------------------------ fake server ------------------------------------------------------------------ */
interface User { id: string; email: string; name: string; authKey: string; recoveryAuth: string; kdf: any; wrappedDek: any; recoveryWrappedDek: any; seq: number; docs: Map<string, { data: any; deleted: boolean; seq: number; updatedAt: string }>; shots: Map<string, Uint8Array> }
export interface LoggedRequest { method: string; path: string; headers: Record<string, string>; bodyText: string | null; bodyBytes: Uint8Array | null }

const isEnv = (e: any) => e && typeof e === 'object' && !Array.isArray(e) && e.v === 1 && typeof e.iv === 'string' && typeof e.ct === 'string' && Object.keys(e).length === 3;

export class FakeServer {
  users = new Map<string, User>();
  sessions = new Map<string, string>();
  log: LoggedRequest[] = [];
  offline = false;
  failNext: { match: (r: LoggedRequest) => boolean; status: number; code: string; times: number }[] = [];
  holds: { match: (r: LoggedRequest) => boolean; gate: Promise<void>; open: () => void; reached: () => void; reachedP: Promise<void> }[] = [];
  inFlight = 0;
  maxInFlight = 0;
  pageCap = Infinity;
  private n = 0;

  hold(match: (r: LoggedRequest) => boolean) {
    let open!: () => void, reached!: () => void;
    const gate = new Promise<void>(r => (open = r));
    const reachedP = new Promise<void>(r => (reached = r));
    const h = { match, gate, open, reached, reachedP };
    this.holds.push(h);
    return { release: () => { h.open(); this.holds = this.holds.filter(x => x !== h); }, reached: reachedP };
  }

  fetch = async (url: string, init: any) => {
    if (this.offline) throw new TypeError('offline');
    const u = new URL(url);
    const body = init.body;
    const r: LoggedRequest = {
      method: init.method, path: u.pathname + u.search, headers: { ...(init.headers || {}) },
      bodyText: typeof body === 'string' ? body : null, bodyBytes: body instanceof Uint8Array ? body : null
    };
    this.log.push(r);
    this.inFlight++; this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      for (const h of this.holds.slice()) if (h.match(r)) { h.reached(); await h.gate; }
      for (const f of this.failNext) if (f.times > 0 && f.match(r)) { f.times--; return this.err(f.status, f.code); }
      await new Promise(res => setImmediate(res));
      return this.route(r, u);
    } finally { this.inFlight--; }
  };

  private err(status: number, code: string, message = code) { return new Response(JSON.stringify({ error: { code, message } }), { status, headers: { 'Content-Type': 'application/json' } }); }
  private ok(b: unknown, status = 200) { return new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }); }

  private authed(r: LoggedRequest) {
    const m = /^Bearer (.+)$/.exec(r.headers.Authorization || '');
    const id = m && this.sessions.get(m[1]);
    return id ? this.users.get(id)! : null;
  }
  private session(u: User) { const t = 'tok' + (++this.n) + 'x'.repeat(30); this.sessions.set(t, u.id); return { token: t, expiresAt: Date.now() + 1e9, user: { id: u.id, email: u.email, name: u.name } }; }
  private byEmail(e: string) { for (const u of this.users.values()) if (u.email === e) return u; return null; }

  private async route(r: LoggedRequest, u: URL): Promise<Response> {
    const p = u.pathname, j = r.bodyText ? JSON.parse(r.bodyText) : null;
    if (p === '/v1/auth/prelogin') {
      const us = this.byEmail(j.email);
      return this.ok(us ? us.kdf : { alg: 'pbkdf2-sha256', iterations: 1000, salt: 'ZmFrZWZha2VmYWtlZmFrZQ' });
    }
    if (p === '/v1/auth/signup') {
      if (this.byEmail(j.email)) return this.err(409, 'email_taken');
      for (const k of ['wrappedDek', 'recoveryWrappedDek']) if (!isEnv(j[k])) return this.err(422, 'validation_failed');
      const us: User = { id: 'u' + (++this.n), email: j.email, name: j.name, authKey: j.authKey, recoveryAuth: j.recoveryAuth, kdf: j.kdf, wrappedDek: j.wrappedDek, recoveryWrappedDek: j.recoveryWrappedDek, seq: 0, docs: new Map(), shots: new Map() };
      this.users.set(us.id, us);
      return this.ok(this.session(us), 201);
    }
    if (p === '/v1/auth/login') {
      const us = this.byEmail(j.email);
      if (!us || us.authKey !== j.authKey) return this.err(401, 'invalid_credentials');
      return this.ok({ ...this.session(us), kdf: us.kdf, wrappedDek: us.wrappedDek });
    }
    if (p === '/v1/auth/recover') {
      const us = this.byEmail(j.email);
      if (!us || us.recoveryAuth !== j.recoveryAuth) return this.err(401, 'invalid_credentials');
      if (!j.authKey) return this.ok({ recoveryWrappedDek: us.recoveryWrappedDek, kdf: us.kdf });
      us.authKey = j.authKey; us.kdf = j.kdf; us.wrappedDek = j.wrappedDek;
      for (const [t, id] of this.sessions) if (id === us.id) this.sessions.delete(t);
      return this.ok({ ...this.session(us), kdf: us.kdf, wrappedDek: us.wrappedDek });
    }
    const us = this.authed(r);
    if (!us) return this.err(401, 'unauthorized');
    if (p === '/v1/auth/logout') { this.sessions.delete(r.headers.Authorization.slice(7)); return new Response(null, { status: 204 }); }
    if (p === '/v1/auth/keys') return this.ok({ kdf: us.kdf, wrappedDek: us.wrappedDek });
    if (p === '/v1/auth/change-password') {
      if (us.authKey !== j.currentAuthKey) return this.err(401, 'invalid_credentials');
      us.authKey = j.newAuthKey; us.kdf = j.kdf; us.wrappedDek = j.wrappedDek;
      const keep = r.headers.Authorization.slice(7);
      for (const [t, id] of this.sessions) if (id === us.id && t !== keep) this.sessions.delete(t);
      return new Response(null, { status: 204 });
    }
    if (p === '/v1/sync') {
      const since = Number(u.searchParams.get('since') || 0), limit = Number(u.searchParams.get('limit') || 200);
      const all = [...us.docs.entries()].map(([k, d]) => ({ k, d })).filter(x => x.d.seq > since && (since > 0 || !x.d.deleted)).sort((a, b) => a.d.seq - b.d.seq);
      const lim = Math.min(limit, this.pageCap), hasMore = all.length > lim, page = all.slice(0, lim);
      return this.ok({
        docs: page.map(x => { const [collection, id] = x.k.split('/'); return { collection, id, data: x.d.data, deleted: x.d.deleted, updatedAt: x.d.updatedAt, seq: x.d.seq }; }),
        cursor: hasMore ? page[page.length - 1].d.seq : us.seq, hasMore
      });
    }
    let m = /^\/v1\/docs\/([^/]+)\/([^/]+)$/.exec(p);
    if (m) {
      const col = decodeURIComponent(m[1]), id = decodeURIComponent(m[2]), k = col + '/' + id, cur = us.docs.get(k);
      if (r.method === 'GET') return cur && !cur.deleted ? this.ok({ collection: col, id, data: cur.data, updatedAt: cur.updatedAt, seq: cur.seq }) : this.err(404, 'not_found');
      if (r.method === 'PUT') {
        if (!isEnv(j)) return this.err(422, 'validation_failed', 'body must be an encrypted envelope');
        const bs = u.searchParams.get('baseSeq');
        if (bs !== null) { const live = cur && !cur.deleted ? cur.seq : 0; if (Number(bs) !== live) return this.err(409, 'conflict'); }
        us.seq++; us.docs.set(k, { data: j, deleted: false, seq: us.seq, updatedAt: new Date().toISOString() });
        return this.ok({ collection: col, id, updatedAt: '', seq: us.seq });
      }
      if (r.method === 'DELETE') { if (cur && !cur.deleted) { us.seq++; us.docs.set(k, { data: null, deleted: true, seq: us.seq, updatedAt: '' }); } return new Response(null, { status: 204 }); }
    }
    m = /^\/v1\/shots\/([^/]+)\/([^/]+)$/.exec(p);
    if (m) {
      const k = m[1] + '/' + m[2];
      if (r.method === 'PUT') { us.shots.set(k, r.bodyBytes!); return this.ok({ machineId: m[1], shotId: m[2], size: r.bodyBytes!.length, updatedAt: '' }, 201); }
      if (r.method === 'GET') { const b = us.shots.get(k); return b ? new Response(b as unknown as BodyInit) : this.err(404, 'not_found'); }
      if (r.method === 'DELETE') { us.shots.delete(k); return new Response(null, { status: 204 }); }
    }
    if (p === '/v1/shots') return this.ok({ shots: [...us.shots.entries()].map(([k, b]) => ({ machineId: k.split('/')[0], shotId: k.split('/')[1], size: b.length, createdAt: '', updatedAt: '' })) });
    return this.err(404, 'not_found');
  }

  /** Test helper: what the server stored for a doc. */
  stored(email: string, col: string, id: string) { return this.byEmail(email)?.docs.get(col + '/' + id); }
  user(email: string) { return this.byEmail(email)!; }
  /** Test helper: write directly as if from another device (needs the already-encrypted envelope). */
  rawPut(email: string, col: string, id: string, env: any) { const us = this.byEmail(email)!; us.seq++; us.docs.set(col + '/' + id, { data: env, deleted: false, seq: us.seq, updatedAt: '' }); }
}

export interface Device {
  sync: ReturnType<typeof createSync>;
  clock: FakeClock; kv: MemoryKV; keys: MemoryKeyStore; life: FakeLifecycle;
  events: { name: string; detail: any }[];
}
export function makeDevice(server: FakeServer, over: { kv?: MemoryKV; keys?: MemoryKeyStore | null; clock?: FakeClock; iterations?: number; pollMs?: number; crypto?: Deps['crypto']; minIterations?: number } = {}): Device {
  const clock = over.clock ?? new FakeClock(), kv = over.kv ?? new MemoryKV(), life = new FakeLifecycle();
  const keys = over.keys === null ? undefined : over.keys ?? new MemoryKeyStore();
  const events: Device['events'] = [];
  const sync = createSync({
    storage: kv, fetch: server.fetch as any, crypto: over.crypto ?? cryptoImpl, clock, lifecycle: life, keyStore: keys,
    emit: (name, detail) => events.push({ name, detail })
  }, { baseUrl: 'http://sync.test', pollMs: over.pollMs ?? 1000, kdfIterations: over.iterations ?? 1000, minKdfIterations: over.minIterations ?? 1000 });
  return { sync, clock, kv, keys: keys as MemoryKeyStore, life, events };
}

/** A crypto wrapper that records every secret byte string the client handles, so tests can prove none reaches the network. */
export function spyCrypto() {
  const secrets: Uint8Array[] = [];
  const keep = (d: any) => { const u = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d); if (u.length >= 8) secrets.push(u.slice()); };
  const sub: any = {
    importKey: (f: any, data: any, ...rest: any[]) => { if (f === 'raw') keep(data); return (subtle.importKey as any)(f, data, ...rest); },
    deriveBits: async (alg: any, key: any, len: number) => { const r = await subtle.deriveBits(alg, key, len); if (alg.name === 'PBKDF2') keep(r); return r; },
    deriveKey: async (alg: any, key: any, dalg: any, ext: any, use: any) => { if (alg.name === 'HKDF') keep(await subtle.deriveBits(alg, key, 256)); return subtle.deriveKey(alg, key, dalg, ext, use); },
    encrypt: (...a: any[]) => (subtle.encrypt as any)(...a),
    decrypt: (...a: any[]) => (subtle.decrypt as any)(...a),
    digest: (...a: any[]) => (subtle.digest as any)(...a)
  };
  const crypto = {
    subtle: sub as SubtleCrypto,
    getRandomValues: <T extends ArrayBufferView | null>(a: T): T => { const r = webcrypto.getRandomValues(a as any) as any; if (r && r.byteLength === 32) keep(r); return r; }
  };
  return { crypto, secrets };
}

const forms = (u: Uint8Array) => {
  const b = Buffer.from(u);
  return [b.toString('base64'), b.toString('base64url'), b.toString('hex'), b.toString('latin1')];
};

/** Every string a secret could appear as in a request: returns the first leak found, or null. */
export function findLeak(log: LoggedRequest[], secrets: Uint8Array[], texts: string[]): string | null {
  const needles = [...texts.filter(t => t.length >= 6), ...secrets.flatMap(forms)];
  for (const r of log) {
    const hay = [r.path, JSON.stringify(r.headers), r.bodyText ?? '', r.bodyBytes ? Buffer.from(r.bodyBytes).toString('latin1') : ''].join('\n');
    for (const n of needles) if (hay.includes(n)) return `${r.method} ${r.path} contains ${n.slice(0, 12)}...`;
  }
  return null;
}
