/**
 * Bloom sync core: a Firestore-shaped facade (the subset Bloom uses) over the Bloom backend, with end-to-end encryption.
 *
 * Design rules (see packages/sync/README.md for the long form):
 *  - Local cache + persisted write queue are the source of truth on the device. The server holds ciphertext only.
 *  - Cache = last known SERVER state per document. Snapshots are cache + pending queue ops overlaid, so a local write is
 *    visible at once and nothing needs to be "un-applied" if a write fails.
 *  - Single-flight flush and pull; one ordered notification path; a generation counter makes every async continuation
 *    from before a logout / re-login a no-op.
 *  - A failed request, decrypt or tamper never removes cached data.
 */
import {
  CryptoError, decodeRecoveryKey, decryptDoc, decryptShot, deriveKeys, deriveRecovery, encodeRecoveryKey, encryptDoc, encryptShot,
  importDek, newDekBytes, newKdf, randomBytes, b64u, unwrapDek, wrapDek, AAD_DEK_RECOVERY, normalizeEmail, type Envelope, type Kdf
} from './crypto.ts';
import { Hlc, applyOp, compact, emptyState, fromWire, isLive, maxHlc, mergeStates, toWire, visibleFields, type DocState, type Stamp } from './merge.ts';
import type { Deps, Options, Session, SessionUser, SyncError, SyncStatus, Unsub } from './types.ts';
import { DEFAULT_ITERATIONS, MIN_ITERATIONS } from './crypto.ts';

const P = 'bloomsync:';
const ROOT_COL = '_root';
const MAX_MERGE_RETRIES = 5;

type Doc = Record<string, unknown>;
/** d = the fields Bloom sees; m / del = merge metadata (field stamps, document-delete stamp); s = server seq. A dead entry (del hides all) is kept as the merge base. */
interface CacheEntry { d: Doc; s: number; m?: Record<string, Stamp>; del?: Stamp | null }
interface Cache { cursor: number; docs: Record<string, CacheEntry>; synced: boolean; bad: Record<string, number> }
interface Op { uid: string; op: 'set' | 'update' | 'delete'; col: string; id: string; data?: Doc; n: number; hlc: string; fm?: Record<string, string> }
interface Waiter { resolve(v?: unknown): void; reject(e: unknown): void }
interface Listener { col: string; field: string | null; dir: 'asc' | 'desc' | null; limit: number | null; next: (s: any) => void; err?: (e: any) => void; started: boolean; dead: boolean }

export function fail(code: string, message?: string, extra?: Record<string, unknown>): SyncError {
  const e = new Error(message || code) as SyncError;
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}
const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const keyOf = (col: string, id: string) => col + '/' + id;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function createSync(deps: Deps, initial: Partial<Options> = {}) {
  const cfg: Options = { baseUrl: '', pollMs: 15000, kdfIterations: DEFAULT_ITERATIONS, minKdfIterations: MIN_ITERATIONS, timeoutMs: 20000, ...initial };
  const { clock, crypto: cr } = deps;

  /* ---------- persistence (async KV, writes coalesced and ordered per key) ---------- */
  async function kvGet<T>(k: string): Promise<T | null> {
    try { const s = await deps.storage.get(P + k); return s == null ? null : (JSON.parse(s) as T); } catch { return null; }
  }
  const writers = new Map<string, { running: boolean; dirty: boolean }>();
  function kvWrite(k: string, get: () => unknown | undefined): void {
    let w = writers.get(k);
    if (!w) { w = { running: false, dirty: false }; writers.set(k, w); }
    if (w.running) { w.dirty = true; return; }
    w.running = true;
    const st = w;
    void (async () => {
      do {
        st.dirty = false;
        try {
          const v = get();
          if (v === undefined) await deps.storage.remove(P + k); else await deps.storage.set(P + k, JSON.stringify(v));
        } catch { /* storage full or blocked: the in-memory copy still works */ }
      } while (st.dirty);
      st.running = false;
    })();
  }

  const entryState = (e: CacheEntry | undefined): DocState => (e ? { f: clone(e.d), m: e.m ?? {}, del: e.del ?? null } : emptyState());
const stateEntry = (st: DocState, seq: number): CacheEntry => { const c = compact(st); return { d: c.f as Doc, s: seq, m: c.m, del: c.del }; };
const liveEntry = (e: CacheEntry | undefined) => !!e && isLive(entryState(e));

/* ---------- state ---------- */
  let session: Session | null = null;
  let dek: CryptoKey | null = null;
  let gen = 0; // bumped whenever the signed-in identity changes; async work from an older generation must not touch state
  let cacheState: Cache | null = null;
  let queue: Op[] = [];
  let counter = 0;
  let deviceId = '';
  const hlc = new Hlc();
  let lastSyncAt: number | null = null;
  const errs: { flush: { code: string; message: string } | null; pull: { code: string; message: string } | null } = { flush: null, pull: null };
  let lastStatusJson = '';

  const uid = () => (session ? session.user.id : null);
  const blankCache = (): Cache => ({ cursor: 0, docs: {}, synced: false, bad: {} });

  function emit(name: string, detail: unknown) { try { deps.emit?.(name, detail); } catch { /* UI listener errors are not ours */ } }
  function status(): SyncStatus {
    const pend = pending().length;
    let state: SyncStatus['state'];
    if (!session) state = 'signed-out';
    else if (!dek) state = 'locked';
    else if (errs.flush || errs.pull) state = (errs.flush || errs.pull)!.code === 'unavailable' ? 'offline' : 'error';
    else state = pend ? 'pending' : 'synced';
    const error = errs.flush || errs.pull;
    return { state, pending: pend, lastSyncAt, error: error ? { ...error } : null };
  }
  function publishStatus() {
    const s = status();
    const j = JSON.stringify([s.state, s.pending, s.error && s.error.code]);
    if (j === lastStatusJson) return;
    lastStatusJson = j;
    emit('bloomsync:status', s);
  }
  function setError(kind: 'flush' | 'pull', e: unknown) {
    const x = e as SyncError;
    if (x && (x.code === 'stale' || x.code === 'locked')) return;
    errs[kind] = { code: x && x.code ? x.code : 'error', message: x && x.message ? x.message : 'Sync failed' };
    publishStatus();
  }
  function clearError(kind: 'flush' | 'pull') { errs[kind] = null; publishStatus(); }
  function resetErrors() { errs.flush = null; errs.pull = null; }

  /* ---------- network ---------- */
  async function doFetch(url: string, init: { method: string; headers: Record<string, string>; body?: any; signal?: any }) {
    const ctl = deps.abort ? deps.abort() : null;
    if (ctl) init.signal = ctl.signal;
    let timer: unknown;
    const timeout = new Promise<never>((_, rej) => { timer = clock.setTimeout(() => { try { ctl?.abort(); } catch { /* ignore */ } rej(fail('unavailable', 'Request timed out')); }, cfg.timeoutMs); });
    try {
      return await Promise.race([Promise.resolve(deps.fetch(url, init)), timeout]);
    } catch (e) {
      if (e && (e as SyncError).code) throw e;
      throw fail('unavailable', 'Network error', { cause: e });
    } finally { clock.clearTimeout(timer); }
  }

  interface ReqOpts { json?: unknown; body?: Uint8Array; auth?: boolean; headers?: Record<string, string>; binary?: boolean }
  async function request(method: string, path: string, opts: ReqOpts = {}): Promise<{ status: number; body: any }> {
    const myGen = gen, tok = session ? session.token : null;
    const headers: Record<string, string> = { ...(opts.headers || {}) };
    if (tok && opts.auth !== false) headers.Authorization = 'Bearer ' + tok;
    const init: { method: string; headers: Record<string, string>; body?: any } = { method, headers };
    if (opts.json !== undefined) { init.body = JSON.stringify(opts.json); headers['Content-Type'] = 'application/json'; }
    if (opts.body) init.body = opts.body;
    const r = await doFetch(cfg.baseUrl.replace(/\/+$/, '') + path, init);
    if (gen !== myGen && opts.auth !== false) throw fail('stale', 'Signed-in account changed during the request');
    if (r.status === 204) return { status: 204, body: null };
    if (r.ok && opts.binary) return { status: r.status, body: new Uint8Array(await r.arrayBuffer()) };
    const b = await r.json().catch(() => null);
    if (r.ok) return { status: r.status, body: b };
    const err = b && b.error ? b.error : {};
    if (r.status === 401 && opts.auth !== false && tok && session && session.token === tok && gen === myGen) handleUnauthorized();
    throw fail(err.code || 'http_' + r.status, err.message || 'Request failed', { status: r.status });
  }

  function handleUnauthorized() {
    /* keep queued writes; they resume if the same account signs in again */
    const u = session && session.user;
    const id = uid();
    gen++; session = null; dek = null; cacheState = null;
    kvWrite('session', () => undefined);
    stopPolling();
    if (id && deps.keyStore) deps.keyStore.clear(id).catch(() => {});
    emit('bloomsync:authchange', { user: null, expired: true, previous: u });
    publishStatus();
  }

  /* ---------- cache ---------- */
  const cache = (): Cache => {
    if (!cacheState) cacheState = blankCache();
    return cacheState;
  };
  let persistTimer: unknown = null;
  function persistNow() {
    if (persistTimer) { clock.clearTimeout(persistTimer); persistTimer = null; }
    const id = uid(), c = cacheState;
    if (id && c) kvWrite('cache:' + id, () => c);
  }
  function persistCache() {
    if (persistTimer) return;
    persistTimer = clock.setTimeout(() => { persistTimer = null; persistNow(); }, 250);
  }
  const saveQueue = () => kvWrite('queue', () => queue);

  /* ---------- write queue ---------- */
  let inflight: Op | null = null, flushing: Promise<void> | null = null, flushTimer: unknown = null, backoffStep = 0;
  const waiters = new Map<Op, Waiter[]>();
  const pending = () => { const me = uid(); return queue.filter(q => q.uid === me); };
  const hasPending = (col: string, id: string) => { const me = uid(); return queue.some(q => q.uid === me && q.col === col && q.id === id); };

  function settle(item: Op, err: unknown, value?: unknown) {
    const w = waiters.get(item); waiters.delete(item);
    if (w) w.forEach(x => (err ? x.reject(err) : x.resolve(value)));
  }
  function mergeWaiters(from: Op, to: Op) {
    const a = waiters.get(from);
    if (a) { waiters.set(to, (waiters.get(to) || []).concat(a)); waiters.delete(from); }
  }

  function stampNow(): string {
    const h = hlc.tick(clock.now());
    kvWrite('hlc', () => hlc.state);
    return h;
  }
  function enqueue(op: Op['op'], col: string, id: string, data?: Doc): Promise<unknown> {
    const me = uid();
    if (!me) return Promise.reject(fail('unauthenticated', 'Not signed in'));
    let item: Op = { uid: me, op, col, id, data: data === undefined ? undefined : clone(data), n: ++counter, hlc: stampNow() };
    /* coalesce with an earlier queued (not in-flight) op on the same document, keeping each field's own stamp */
    let prior: Op | null = null;
    for (let i = queue.length - 1; i >= 0; i--) { const q = queue[i]; if (q.uid === me && q.col === col && q.id === id) { prior = q; break; } }
    const p = new Promise((resolve, reject) => {
      if (prior && prior !== inflight) {
        if (op === 'set' || op === 'delete') { queue.splice(queue.indexOf(prior), 1); mergeWaiters(prior, item); queue.push(item); }
        else if (op === 'update' && (prior.op === 'set' || prior.op === 'update')) {
          const fm = Object.assign({}, prior.fm);
          for (const k of Object.keys(prior.data || {})) if (!fm[k]) fm[k] = prior.hlc;
          for (const k of Object.keys(item.data || {})) fm[k] = item.hlc;
          prior.data = Object.assign({}, prior.data, item.data); prior.fm = fm;
          if (prior.op === 'update') prior.hlc = item.hlc; /* a pure update's own stamp is irrelevant; fm carries each field's */
          item = prior;
        } else queue.push(item);
      } else queue.push(item);
      const w = waiters.get(item) || []; w.push({ resolve, reject }); waiters.set(item, w);
    });
    saveQueue();
    queueNotify([col]);
    publishStatus();
    scheduleFlush(0);
    return p;
  }

  function scheduleFlush(ms: number) {
    if (flushTimer) { clock.clearTimeout(flushTimer); flushTimer = null; }
    if (ms <= 0) { void Promise.resolve().then(() => flush().catch(() => {})); return; } /* immediate: no timer, so it is independent of the clock */
    flushTimer = clock.setTimeout(() => { flushTimer = null; flush().catch(() => {}); }, ms);
  }

  function flush(): Promise<void> {
    if (flushing) return flushing;
    const p = runFlush().then(() => { if (flushing === p) flushing = null; }, e => { if (flushing === p) flushing = null; throw e; });
    flushing = p;
    return p;
  }

  async function runFlush(): Promise<void> {
    const myGen = gen;
    for (;;) {
      const me = uid();
      const item = me ? queue.find(q => q.uid === me) : undefined;
      if (!item) { backoffStep = 0; if (me) clearError('flush'); return; }
      if (!dek) throw fail('locked', 'Sync is locked: enter your password');
      inflight = item;
      let result: { seq: number; state?: DocState };
      try {
        result = await send(item);
      } catch (e) {
        inflight = null;
        if (gen !== myGen) { scheduleFlush(0); return; }
        const x = e as SyncError;
        const permanent = x && x.status && x.status >= 400 && x.status < 500 && x.status !== 401 && x.status !== 429 && x.status !== 408 && x.code !== 'conflict';
        if (permanent) {
          queue.splice(queue.indexOf(item), 1); saveQueue();
          if (x.status === 404 && item.op === 'update') { delete cache().docs[keyOf(item.col, item.id)]; persistCache(); }
          settle(item, x); queueNotify([item.col]); publishStatus();
          continue;
        }
        /* offline / server trouble / signed out: reject current waiters, keep the op, retry later */
        settle(item, x);
        backoffStep = Math.min(backoffStep + 1, 6);
        setError('flush', x);
        if (uid()) scheduleFlush(Math.min(300000, 3000 * Math.pow(2, backoffStep - 1)));
        throw x;
      }
      inflight = null;
      if (gen !== myGen) { scheduleFlush(0); return; }
      /* record the new server state and drop the op in one synchronous step so snapshots never flicker */
      const c = cache(), k = keyOf(item.col, item.id), old = c.docs[k];
      if (result.state && (!old || result.seq >= old.s)) c.docs[k] = stateEntry(result.state, result.seq);
      queue.splice(queue.indexOf(item), 1); saveQueue(); persistCache();
      lastSyncAt = clock.now();
      settle(item, null);
      queueNotify([item.col]);
      publishStatus();
    }
  }

  /**
   * Encrypts and sends one op as read-merge-write: merge the op into the latest known server state of the document,
   * field by field (higher HLC wins, see merge.ts), and PUT it conditionally on that state's seq. If another device wrote
   * first the server answers 409; we re-read the latest, merge again and retry.
   */
  async function send(item: Op): Promise<{ seq: number; state?: DocState }> {
    const key = dek!, path = '/v1/docs/' + encodeURIComponent(item.col) + '/' + encodeURIComponent(item.id);
    for (let attempt = 0; attempt < MAX_MERGE_RETRIES; attempt++) {
      let base: CacheEntry | undefined = cache().docs[keyOf(item.col, item.id)];
      if (!base && (item.op !== 'set' || attempt > 0)) base = await fetchDoc(item.col, item.id); // set can optimistically try "create" (baseSeq 0)
      if (item.op === 'update' && !base) throw fail('not_found', 'Document not found', { status: 404 });
      if (item.op === 'delete' && !base) return { seq: 0 }; // nothing there to delete
      const merged = applyOp(entryState(base), item, deviceId);
      try {
        const r = await request('PUT', path + '?baseSeq=' + (base ? base.s : 0), { json: await encryptDoc(cr, key, item.uid, item.col, item.id, toWire(merged)) });
        return { seq: r.body.seq, state: merged };
      } catch (e) {
        if ((e as SyncError).code !== 'conflict') throw e;
        await fetchDoc(item.col, item.id); // someone else wrote first: re-read the latest and merge again
      }
    }
    throw fail('conflict', 'Too many simultaneous edits; will retry', { status: 0 });
  }

  /** GET one document into the cache (server truth). Returns undefined if the server has no live copy. */
  async function fetchDoc(col: string, id: string): Promise<CacheEntry | undefined> {
    const myGen = gen, key = dek;
    if (!key) throw fail('locked', 'Sync is locked');
    const me = uid()!;
    let r;
    try { r = await request('GET', '/v1/docs/' + encodeURIComponent(col) + '/' + encodeURIComponent(id)); }
    catch (e) { if ((e as SyncError).status === 404) { if (gen === myGen) delete cache().docs[keyOf(col, id)]; return undefined; } throw e; }
    const st = fromWire(await decryptDoc(cr, key, me, col, id, r.body.data));
    if (gen !== myGen) throw fail('stale', 'Signed-in account changed');
    hlc.recv(maxHlc(st), clock.now());
    const entry = stateEntry(st, r.body.seq as number);
    const old = cache().docs[keyOf(col, id)];
    if (!old || entry.s >= old.s) cache().docs[keyOf(col, id)] = entry;
    return cache().docs[keyOf(col, id)];
  }

  /* ---------- pull (incremental sync) ---------- */
  let pulling: Promise<void> | null = null, pullAgain = false;
  function pull(): Promise<void> {
    if (!session) return Promise.reject(fail('unauthenticated', 'Not signed in'));
    if (!dek) return Promise.reject(fail('locked', 'Sync is locked: enter your password'));
    if (pulling) { pullAgain = true; return pulling; } /* a request that arrives mid-pull gets one more full pass */
    const p = runPull().then(() => { if (pulling === p) pulling = null; }, e => { if (pulling === p) pulling = null; setError('pull', e); throw e; });
    pulling = p;
    return p;
  }

  async function runPull(): Promise<void> {
    const myGen = gen, key = dek!, me = uid()!;
    do {
      pullAgain = false;
      for (let more = true; more;) {
        const c = cache();
        const r = await request('GET', '/v1/sync?since=' + c.cursor + '&limit=500');
        if (gen !== myGen) return;
        if (!r.body || !Array.isArray(r.body.docs) || !Number.isFinite(r.body.cursor)) throw fail('bad_response', 'Unexpected response from the server');
        const b = r.body as { docs: { collection: string; id: string; data: Envelope | null; deleted: boolean; seq: number }[]; cursor: number; hasMore: boolean };
        const plain = await Promise.all(b.docs.map(async d => {
          if (d.deleted || d.data === null) return null;
          try { return fromWire(await decryptDoc(cr, key, me, d.collection, d.id, d.data)); } catch { return undefined; }
        }));
        if (gen !== myGen) return;
        const changed: Record<string, 1> = {};
        b.docs.forEach((d, i) => {
          const k = keyOf(d.collection, d.id), old = c.docs[k], p = plain[i];
          if (d.deleted || d.data === null) { if (old && d.seq >= old.s) { delete c.docs[k]; changed[d.collection] = 1; } delete c.bad[k]; return; }
          if (p === undefined) { c.bad[k] = d.seq; return; }
          if (p === null) return; /* failed authentication: keep whatever we had */
          if (old && d.seq < old.s) return; /* never regress to an older server copy */
          hlc.recv(maxHlc(p), clock.now()); /* fold remote stamps into our clock so skew cannot make old edits win forever */
          const ne = stateEntry(p, d.seq), was = old && liveEntry(old) ? JSON.stringify(old.d) : null, now = liveEntry(ne) ? JSON.stringify(ne.d) : null;
          if (was !== now) changed[d.collection] = 1;
          c.docs[k] = ne; delete c.bad[k];
        });
        c.cursor = Math.max(c.cursor, b.cursor);
        if (!b.hasMore) c.synced = true;
        persistCache();
        queueNotify(Object.keys(changed));
        more = b.hasMore;
      }
    } while (pullAgain);
    lastSyncAt = clock.now();
    const unverified = Object.keys(cache().bad).length; /* stays flagged until those documents are rewritten or deleted */
    if (unverified) setError('pull', fail('integrity', unverified + (unverified === 1 ? ' item' : ' items') + ' could not be verified and were skipped'));
    else clearError('pull');
  }

  /* ---------- polling, lifecycle ---------- */
  const listeners: Listener[] = [];
  let pollTimer: unknown = null;
  const canSync = () => !!session && !!dek && !!cfg.baseUrl;
  function startPolling() {
    if (pollTimer || !listeners.length) return;
    pollTimer = clock.setInterval(() => { if (deps.lifecycle.isVisible() && canSync()) void tick(); }, cfg.pollMs);
  }
  function stopPolling() { if (pollTimer) { clock.clearInterval(pollTimer); pollTimer = null; } }
  function tick(): Promise<void> {
    return flush().catch(() => {}).then(() => pull()).then(() => {}, () => {});
  }
  const unsubs: Unsub[] = [
    deps.lifecycle.onHide(() => persistNow()),
    deps.lifecycle.onOnline(() => { if (canSync()) void tick(); }),
    deps.lifecycle.onVisible(() => { if (canSync() && listeners.length) void tick(); })
  ];

  /* ---------- snapshots (ordered: one notification path, built from the latest state at delivery time) ---------- */
  const dirtyCols = new Set<string>();
  let notifyScheduled = false;
  function queueNotify(cols?: string[]) {
    if (cols) cols.forEach(c => dirtyCols.add(c)); else dirtyCols.add('*');
    if (notifyScheduled) return;
    notifyScheduled = true;
    void Promise.resolve().then(() => {
      notifyScheduled = false;
      const all = dirtyCols.has('*');
      const cols2 = new Set(dirtyCols); dirtyCols.clear();
      listeners.slice().forEach(l => { if (l.started && !l.dead && (all || cols2.has(l.col))) emit1(l); });
    });
  }

  /** Server state with pending local ops laid over it. */
  function viewRows(col: string): Map<string, { d: Doc; s: number }> {
    const c = cache(), prefix = col + '/';
    const states = new Map<string, { st: DocState; s: number }>();
    for (const k of Object.keys(c.docs)) if (k.startsWith(prefix)) states.set(k.slice(prefix.length), { st: entryState(c.docs[k]), s: c.docs[k].s });
    const me = uid();
    for (const q of queue) {
      if (q.uid !== me || q.col !== col) continue;
      const cur = states.get(q.id);
      if (q.op === 'update' && !cur) continue; /* unknown locally: the server decides */
      states.set(q.id, { st: applyOp(cur ? cur.st : emptyState(), q, deviceId), s: cur ? cur.s : 0 });
    }
    const rows = new Map<string, { d: Doc; s: number }>();
    for (const [id, e] of states) if (isLive(e.st)) rows.set(id, { d: visibleFields(e.st) as Doc, s: e.s });
    return rows;
  }
  function viewDoc(col: string, id: string) { return viewRows(col).get(id); }

  function makeDocSnap(id: string, data: Doc | undefined | null) {
    return { id, exists: data !== undefined && data !== null, data: () => (data == null ? undefined : clone(data)), ref: null as unknown };
  }

  function snapshotFor(l: Pick<Listener, 'col' | 'field' | 'dir' | 'limit'>) {
    let rows = [...viewRows(l.col)].map(([id, e]) => ({ id, d: e.d, s: e.s || 0 }));
    const f = l.field;
    rows.sort((a, b) => {
      if (!f) return a.s - b.s || cmp(a.id, b.id);
      const x = a.d[f] as any, y = b.d[f] as any;
      let r = x === y ? 0 : x == null ? -1 : y == null ? 1 : x < y ? -1 : 1;
      if (l.dir === 'desc') r = -r;
      return r || cmp(a.id, b.id);
    });
    if (l.limit != null) rows = rows.slice(0, l.limit);
    const docs = rows.map(r => makeDocSnap(r.id, r.d));
    return { docs, size: docs.length, empty: !docs.length, forEach: (fn: (d: any) => void) => docs.forEach(fn) };
  }
  function emit1(l: Listener) {
    if (l.dead) return;
    try { l.next(snapshotFor(l)); } catch (e) { try { deps.log?.('BloomSync listener error', e); } catch { /* ignore */ } }
  }
  function unsubscribe(l: Listener): Unsub {
    return () => { l.dead = true; const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); if (!listeners.length) stopPolling(); };
  }
  function addListener(l: Listener): Unsub {
    const callErr = (e: unknown) => { if (!l.dead && l.err) { try { l.err(e); } catch { /* ignore */ } } };
    if (!session) { void Promise.resolve().then(() => callErr(fail('unauthenticated', 'Not signed in'))); return unsubscribe(l); }
    if (!dek) { void Promise.resolve().then(() => callErr(fail('locked', 'Sync is locked: enter your password'))); return unsubscribe(l); }
    listeners.push(l);
    const myGen = gen;
    startPolling();
    /* First emission waits for a server read, so an empty cache is never mistaken for an empty account.
       Offline, a cache that has synced before is used; otherwise the error callback fires and Bloom stays local. */
    flush().catch(() => {}).then(() => pull()).then(() => { if (gen === myGen) { l.started = true; emit1(l); } }, e => {
      if (l.dead || gen !== myGen) return;
      if (cache().synced) { l.started = true; emit1(l); } else callErr(e);
    });
    return unsubscribe(l);
  }

  /* ---------- Firestore-like facade ---------- */
  function parsePath(path: string) {
    const m = /^data\/users\/([^/]+)\/([^/]+)$/.exec(String(path || ''));
    if (!m) throw fail('invalid-argument', 'Unsupported document path: ' + path);
    return { uid: m[1], name: m[2] };
  }
  function checkUser(id: string) {
    if (!uid() || id !== uid()) throw fail('permission-denied', 'Path belongs to a different user');
    if (!dek) throw fail('locked', 'Sync is locked: enter your password');
  }
  const isObj = (d: unknown): d is Doc => !!d && typeof d === 'object' && !Array.isArray(d);

  class DocRef {
    constructor(public _col: string, public id: string, public _uid: string) {}
    async get() {
      await ready;
      checkUser(this._uid);
      await pull().catch(e => { if (!cache().synced) throw e; }); /* offline: fall back to the cache */
      const e = viewDoc(this._col, this.id);
      return makeDocSnap(this.id, e ? e.d : undefined);
    }
    async set(data: Doc) {
      await ready;
      checkUser(this._uid);
      if (!isObj(data)) throw fail('invalid-argument', 'set() needs an object');
      return enqueue('set', this._col, this.id, data);
    }
    async update(data: Doc) {
      await ready;
      checkUser(this._uid);
      if (!isObj(data)) throw fail('invalid-argument', 'update() needs an object');
      return enqueue('update', this._col, this.id, data);
    }
    async delete() {
      await ready;
      checkUser(this._uid);
      return enqueue('delete', this._col, this.id);
    }
    collection(name: string) {
      if (this._col !== ROOT_COL) throw fail('invalid-argument', 'Nested collections are not supported');
      return new Query(String(name), this._uid, null, null, null);
    }
  }

  class Query {
    constructor(public _col: string, public _uid: string, public _field: string | null, public _dir: 'asc' | 'desc' | null, public _limit: number | null) {}
    doc(id: string) {
      if (typeof id !== 'string' || !id) throw fail('invalid-argument', 'doc() needs an id');
      return new DocRef(this._col, id, this._uid);
    }
    orderBy(field: string, dir?: string) { return new Query(this._col, this._uid, field, dir === 'desc' ? 'desc' : 'asc', this._limit); }
    limit(n: number) { return new Query(this._col, this._uid, this._field, this._dir, n); }
    onSnapshot(next: (s: any) => void, err?: (e: any) => void): Unsub {
      let dead = false, inner: Unsub | null = null;
      void ready.then(() => {
        if (dead) return;
        try { checkUser(this._uid); } catch (e) { if (err) err(e); return; }
        inner = addListener({ col: this._col, field: this._field, dir: this._dir, limit: this._limit, next, err, started: false, dead: false });
      });
      return () => { dead = true; if (inner) inner(); };
    }
    async get() {
      await ready;
      checkUser(this._uid);
      await pull().catch(e => { if (!cache().synced) throw e; });
      return snapshotFor({ col: this._col, field: this._field, dir: this._dir, limit: this._limit });
    }
  }

  const db = { doc(path: string) { const p = parsePath(path); return new DocRef(ROOT_COL, p.name, p.uid); } };
  const user = { id: async () => { await ready; return uid(); }, current: () => auth.current() };

  /* ---------- accounts and keys ---------- */
  let authChain: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = authChain.then(fn);
    authChain = run.then(() => {}, () => {});
    return run;
  }

  interface AuthOpts { staySignedIn?: boolean }
  interface AuthBody { token: string; expiresAt: number; user: SessionUser; kdf?: Kdf }

  async function activate(body: AuthBody, key: CryptoKey, stay: boolean) {
    const prev = uid();
    const loaded = (await kvGet<Cache>('cache:' + body.user.id)) || blankCache();
    if (!loaded.bad) loaded.bad = {};
    gen++;
    stopPolling();
    session = { token: body.token, expiresAt: body.expiresAt, user: body.user, stay };
    dek = key;
    cacheState = loaded;
    resetErrors();
    kvWrite('session', () => session);
    if (deps.keyStore) {
      try { if (stay) await deps.keyStore.save(body.user.id, key); else await deps.keyStore.clear(body.user.id); } catch { /* optional */ }
    }
    if (prev && prev !== body.user.id && deps.keyStore) deps.keyStore.clear(prev).catch(() => {});
    emit('bloomsync:authchange', { user: { ...body.user } });
    publishStatus();
    scheduleFlush(0);
  }

  const needBase = () => { if (!cfg.baseUrl) throw fail('unconfigured', 'Sync is not configured'); };
  const fixed = (email: string) => normalizeEmail(email);

  async function wrongPasswordIf<T>(p: Promise<T>, code = 'invalid_credentials', msg = 'Incorrect password'): Promise<T> {
    try { return await p; } catch (e) { if (e instanceof CryptoError && e.code === 'decrypt_failed') throw fail(code, msg); throw e; }
  }

  const auth = {
    async signup(email: string, password: string, name?: string, opts: AuthOpts = {}) {
      await ready; needBase();
      return serial(async () => {
        email = fixed(email);
        if (typeof password !== 'string' || password.length < 8) throw fail('validation_failed', 'Password must be at least 8 characters');
        const kdf = newKdf(cr, cfg.kdfIterations);
        const keys = await deriveKeys(cr, password, email, kdf, cfg.minKdfIterations);
        const rawDek = newDekBytes(cr), rawRecovery = randomBytes(cr, 32);
        const rk = await deriveRecovery(cr, rawRecovery);
        const wrappedDek = await wrapDek(cr, keys.kek, rawDek);
        const recoveryWrappedDek = await wrapDek(cr, rk.recoveryKek, rawDek, AAD_DEK_RECOVERY);
        const recoveryKey = await encodeRecoveryKey(cr, rawRecovery);
        const key = await importDek(cr, rawDek);
        rawDek.fill(0); rawRecovery.fill(0);
        const r = await request('POST', '/v1/auth/signup', { auth: false, json: { email, name: name || '', authKey: keys.authKey, kdf, wrappedDek, recoveryWrappedDek, recoveryAuth: rk.recoveryAuth } });
        await activate(r.body, key, opts.staySignedIn !== false);
        return { ...(r.body.user as SessionUser), recoveryKey };
      });
    },

    async login(email: string, password: string, opts: AuthOpts = {}) {
      await ready; needBase();
      return serial(async () => {
        email = fixed(email);
        const pre = (await request('POST', '/v1/auth/prelogin', { auth: false, json: { email } })).body as Kdf;
        const keys = await deriveKeys(cr, password, email, pre, cfg.minKdfIterations);
        const r = await request('POST', '/v1/auth/login', { auth: false, json: { email, authKey: keys.authKey } });
        let key: CryptoKey;
        try {
          const raw = await unwrapDek(cr, keys.kek, r.body.wrappedDek);
          key = await importDek(cr, raw); raw.fill(0);
        } catch (e) {
          // The server accepted the password proof but handed back a key we cannot open: do not stay signed in on a bad state.
          await request('POST', '/v1/auth/logout', { headers: { Authorization: 'Bearer ' + r.body.token }, auth: false }).catch(() => {});
          throw e instanceof CryptoError ? fail('integrity', 'Your encryption key could not be verified') : e;
        }
        await activate(r.body, key, opts.staySignedIn !== false);
        return { ...(r.body.user as SessionUser) };
      });
    },

    /** Re-open a signed-in but locked session (no stored key) with the account password. */
    async unlock(password: string, opts: AuthOpts = {}) {
      await ready; needBase();
      return serial(async () => {
        if (!session) throw fail('unauthenticated', 'Not signed in');
        if (dek) return;
        const myGen = gen;
        const k = (await request('GET', '/v1/auth/keys')).body as { kdf: Kdf; wrappedDek: Envelope };
        const keys = await deriveKeys(cr, password, session.user.email, k.kdf, cfg.minKdfIterations);
        const raw = await wrongPasswordIf(unwrapDek(cr, keys.kek, k.wrappedDek));
        const key = await importDek(cr, raw); raw.fill(0);
        if (gen !== myGen || !session) throw fail('stale', 'Signed-in account changed');
        dek = key;
        session.stay = opts.staySignedIn !== false;
        kvWrite('session', () => session);
        if (deps.keyStore) { try { if (session.stay) await deps.keyStore.save(session.user.id, key); } catch { /* optional */ } }
        resetErrors();
        emit('bloomsync:authchange', { user: { ...session.user }, unlocked: true });
        publishStatus();
        scheduleFlush(0);
        if (listeners.length) { startPolling(); void tick(); }
      });
    },

    async logout() {
      await ready;
      return serial(async () => {
        const id = uid();
        if (session && dek) await flush().catch(() => {});
        if (session) await request('POST', '/v1/auth/logout').catch(() => {});
        gen++;
        stopPolling();
        session = null; dek = null; cacheState = null;
        if (persistTimer) { clock.clearTimeout(persistTimer); persistTimer = null; }
        kvWrite('session', () => undefined);
        if (id) {
          kvWrite('cache:' + id, () => undefined);
          queue = queue.filter(q => q.uid !== id); saveQueue();
          if (deps.keyStore) await deps.keyStore.clear(id).catch(() => {});
        }
        resetErrors();
        emit('bloomsync:authchange', { user: null });
        publishStatus();
      });
    },

    /** Forgot the password: the recovery key unwraps the data key, then a new password re-wraps it. Signs in on success. */
    async recover(email: string, recoveryKeyText: string, newPassword: string, opts: AuthOpts = {}) {
      await ready; needBase();
      return serial(async () => {
        email = fixed(email);
        if (typeof newPassword !== 'string' || newPassword.length < 8) throw fail('validation_failed', 'Password must be at least 8 characters');
        const rawRecovery = await decodeRecoveryKey(cr, recoveryKeyText).catch(e => { throw e instanceof CryptoError ? fail('invalid_recovery_key', e.message) : e; });
        const rk = await deriveRecovery(cr, rawRecovery);
        rawRecovery.fill(0);
        const step1 = await request('POST', '/v1/auth/recover', { auth: false, json: { email, recoveryAuth: rk.recoveryAuth } });
        const rawDek = await wrongPasswordIf(unwrapDek(cr, rk.recoveryKek, step1.body.recoveryWrappedDek, AAD_DEK_RECOVERY), 'invalid_recovery_key', 'That recovery key does not open this account');
        const kdf = newKdf(cr, cfg.kdfIterations);
        const keys = await deriveKeys(cr, newPassword, email, kdf, cfg.minKdfIterations);
        const wrappedDek = await wrapDek(cr, keys.kek, rawDek);
        const key = await importDek(cr, rawDek);
        rawDek.fill(0);
        const r = await request('POST', '/v1/auth/recover', { auth: false, json: { email, recoveryAuth: rk.recoveryAuth, authKey: keys.authKey, kdf, wrappedDek } });
        await activate(r.body, key, opts.staySignedIn !== false);
        return { ...(r.body.user as SessionUser) };
      });
    },

    /** Needs the current password (proved by unwrapping the data key locally AND to the server). Other sessions are signed out. */
    async changePassword(currentPassword: string, newPassword: string) {
      await ready; needBase();
      return serial(async () => {
        if (!session) throw fail('unauthenticated', 'Not signed in');
        if (typeof newPassword !== 'string' || newPassword.length < 8) throw fail('validation_failed', 'Password must be at least 8 characters');
        const email = session.user.email;
        const k = (await request('GET', '/v1/auth/keys')).body as { kdf: Kdf; wrappedDek: Envelope };
        const cur = await deriveKeys(cr, currentPassword, email, k.kdf, cfg.minKdfIterations);
        const rawDek = await wrongPasswordIf(unwrapDek(cr, cur.kek, k.wrappedDek), 'invalid_credentials', 'Current password is incorrect');
        const kdf = newKdf(cr, cfg.kdfIterations);
        const next = await deriveKeys(cr, newPassword, email, kdf, cfg.minKdfIterations);
        const wrappedDek = await wrapDek(cr, next.kek, rawDek);
        rawDek.fill(0);
        await request('POST', '/v1/auth/change-password', { json: { currentAuthKey: cur.authKey, newAuthKey: next.authKey, kdf, wrappedDek } });
      });
    },

    current: (): SessionUser | null => (session ? clone(session.user) : null),
    isSignedIn: () => !!session,
    isUnlocked: () => !!session && !!dek,
    state: (): 'signed-out' | 'locked' | 'ready' => (!session ? 'signed-out' : dek ? 'ready' : 'locked')
  };

  /* ---------- shots (raw .slog bytes, encrypted; online only) ---------- */
  const sid = (s: string) => encodeURIComponent(s);
  const shots = {
    async put(machineId: string, shotId: string, bytes: Uint8Array) {
      await ready;
      if (!session || !dek) throw fail(session ? 'locked' : 'unauthenticated', 'Sign in to sync shots');
      const body = await encryptShot(cr, dek, session.user.id, machineId, shotId, bytes);
      return (await request('PUT', `/v1/shots/${sid(machineId)}/${sid(shotId)}`, { body, headers: { 'Content-Type': 'application/octet-stream' } })).body;
    },
    async get(machineId: string, shotId: string) {
      await ready;
      if (!session || !dek) throw fail(session ? 'locked' : 'unauthenticated', 'Sign in to sync shots');
      const r = await request('GET', `/v1/shots/${sid(machineId)}/${sid(shotId)}`, { binary: true });
      return decryptShot(cr, dek, session.user.id, machineId, shotId, r.body);
    },
    async list(opts: { machineId?: string; limit?: number } = {}) {
      await ready;
      if (!session) throw fail('unauthenticated', 'Sign in to sync shots');
      const q = (opts.machineId ? '&machineId=' + sid(opts.machineId) : '') + (opts.limit ? '&limit=' + opts.limit : '');
      return (await request('GET', '/v1/shots?' + q.slice(1))).body.shots as { machineId: string; shotId: string; size: number; createdAt: string; updatedAt: string }[];
    },
    async remove(machineId: string, shotId: string) {
      await ready;
      if (!session) throw fail('unauthenticated', 'Sign in to sync shots');
      await request('DELETE', `/v1/shots/${sid(machineId)}/${sid(shotId)}`);
    }
  };

  /* ---------- init ---------- */
  async function init() {
    const s = await kvGet<Session>('session');
    queue = ((await kvGet<Op[]>('queue')) || []).filter(q => q && typeof q.uid === 'string');
    if (s && s.user && s.token) {
      session = s;
      cacheState = (await kvGet<Cache>('cache:' + s.user.id)) || blankCache();
      if (!cacheState.bad) cacheState.bad = {};
      if (deps.keyStore) { try { dek = await deps.keyStore.load(s.user.id); } catch { dek = null; } }
    } else { session = null; dek = null; cacheState = null; }
    counter = queue.reduce((m, q) => Math.max(m, q.n || 0), 0);
    queue.forEach(q => { if (!q.hlc) q.hlc = '0'; });
    let dev = await kvGet<string>('device');
    if (!dev) { dev = b64u(randomBytes(cr, 8)); kvWrite('device', () => dev); }
    deviceId = dev;
    const saved = await kvGet<{ wall: number; counter: number }>('hlc');
    hlc.state = saved && Number.isFinite(saved.wall) ? { wall: saved.wall, counter: saved.counter | 0 } : { wall: 0, counter: 0 };
    lastStatusJson = '';
    publishStatus();
    if (canSync()) scheduleFlush(0);
  }
  let ready: Promise<void> = init();

  function use(name: 'db'): Promise<typeof db>;
  function use(name: 'user'): Promise<typeof user>;
  function use(name: string): Promise<never>;
  function use(name: string): Promise<unknown> {
    if (name === 'db') return ready.then(() => db);
    if (name === 'user') return ready.then(() => user);
    return Promise.reject(fail('unsupported', 'BloomSync does not provide "' + name + '"'));
  }

  const api = {
    configure(o: Partial<Options> = {}) {
      if (typeof o.baseUrl === 'string') cfg.baseUrl = o.baseUrl;
      if (o.pollMs && o.pollMs > 0) cfg.pollMs = o.pollMs;
      if (o.kdfIterations && o.kdfIterations > 0) cfg.kdfIterations = o.kdfIterations;
      if (o.minKdfIterations && o.minKdfIterations > 0) cfg.minKdfIterations = o.minKdfIterations;
      if (o.timeoutMs && o.timeoutMs > 0) cfg.timeoutMs = o.timeoutMs;
      if (pollTimer) { stopPolling(); startPolling(); }
      if (canSync()) scheduleFlush(0);
      return api;
    },
    get ready() { return ready; },
    auth,
    shots,
    use,
    /** True once a baseUrl is set, someone is signed in AND the data key is available. Bloom prefers BloomSync when this is true. */
    isActive: () => !!cfg.baseUrl && !!session && !!dek,
    isConfigured: () => !!cfg.baseUrl,
    /** Number of writes not yet acknowledged by the server. */
    pendingWrites: () => pending().length,
    status,
    syncNow: () => (canSync() ? tick() : Promise.resolve()),
    /** Stop timers and lifecycle subscriptions (tests, app teardown). */
    destroy() { stopPolling(); if (flushTimer) clock.clearTimeout(flushTimer); if (persistTimer) clock.clearTimeout(persistTimer); unsubs.forEach(u => u()); },
    /** Test hook: forget in-memory state (not storage) and reload from storage. */
    _reset() {
      persistNow(); stopPolling();
      listeners.length = 0; gen++; cacheState = null; pulling = null; flushing = null; inflight = null;
      if (flushTimer) clock.clearTimeout(flushTimer); flushTimer = null;
      waiters.clear(); session = null; dek = null; queue = []; resetErrors();
      ready = init();
      return ready;
    }
  };
  return api;
}

export type SyncApi = ReturnType<typeof createSync>;
