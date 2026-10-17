/*
 * bloom-sync.js: Bloom's own sync backend adapter. Plain browser JS, no build step.
 *
 * Exposes window.BloomSync with:
 *   configure({ baseUrl, pollMs?, fetch? })
 *   auth.signup(email, password, name) / auth.login(email, password) / auth.logout() / auth.current()
 *   use('db') / use('user')  -> a drop-in for the subset of window.claude.use('db'|'user') that Bloom calls:
 *
 *     user.id()                                   -> Promise<string|null>   (null when signed out)
 *     db.doc(path)                                -> DocRef    path = 'data/users/<uid>/<doc>'
 *     DocRef.get()                                -> Promise<{ exists, id, data() }>
 *     DocRef.set(obj) / .update(obj) / .delete()  -> Promise
 *     DocRef.collection(name)                     -> CollectionRef
 *     CollectionRef.doc(id)                       -> DocRef
 *     CollectionRef.orderBy(field, 'desc'|'asc').limit(n).onSnapshot(next, err) -> unsubscribe fn
 *     CollectionRef.onSnapshot(next, err)         (also on any Query)
 *     snapshot = { docs:[{ id, exists, data() }], size, empty, forEach(fn) }
 *
 * Path mapping: 'data/users/<uid>/<name>' is the document (collection '_root', id <name>);
 * '<that doc>.collection(<c>).doc(<id>)' is document <id> in backend collection <c>.
 *
 * Behaviour: every write is applied to a local cache first, queued in localStorage and sent in order,
 * retried with backoff, on focus and when the browser comes back online. Reads and snapshots come from
 * the cache, refreshed by polling GET /v1/sync?since=<cursor> (only while something is listening and the
 * page is visible). Conflict policy: last write wins, per document.
 *
 * Storage keys use the prefix "bloomsync:" (not "bloom.") so Bloom's "erase everything" does not sign you out.
 */
(function (root) {
  'use strict';

  var cfg = { baseUrl: '', pollMs: 15000, fetch: null };
  var P = 'bloomsync:';
  var ROOT_COL = '_root';

  /* ---------- tiny helpers ---------- */
  function ls() { try { return root.localStorage || null; } catch (e) { return null; } }
  function lsGet(k, d) { try { var s = ls(); var v = s && s.getItem(P + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function lsSet(k, v) { try { var s = ls(); if (!s) return false; s.setItem(P + k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function lsDel(k) { try { var s = ls(); if (s) s.removeItem(P + k); } catch (e) {} }
  function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
  function fail(code, message, extra) { var e = new Error(message || code); e.code = code; if (extra) for (var k in extra) e[k] = extra[k]; return e; }
  function fire(name, detail) {
    try { if (root.dispatchEvent && typeof root.CustomEvent === 'function') root.dispatchEvent(new root.CustomEvent(name, { detail: detail })); } catch (e) {}
  }
  function doFetch(url, init) {
    var f = cfg.fetch || root.fetch.bind(root);
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, 20000) : null;
    if (ctl) init.signal = ctl.signal;
    return Promise.resolve(f(url, init)).then(function (r) { if (timer) clearTimeout(timer); return r; },
      function (e) { if (timer) clearTimeout(timer); throw fail('unavailable', 'Network error', { cause: e }); });
  }

  /* ---------- session ---------- */
  var session = lsGet('session', null); // { token, user:{id,email,name}, expiresAt }
  function setSession(s) {
    var prev = session && session.user && session.user.id;
    session = s;
    if (s) lsSet('session', s); else lsDel('session');
    if ((s && s.user && s.user.id) !== prev) { cacheState = null; loadedFor = null; stopPolling(); }
    fire('bloomsync:authchange', { user: s ? s.user : null });
  }
  function uid() { return session && session.user ? session.user.id : null; }

  function request(method, path, opts) {
    opts = opts || {};
    var headers = {};
    if (session && opts.auth !== false) headers.Authorization = 'Bearer ' + session.token;
    var init = { method: method, headers: headers };
    if (opts.json !== undefined) { init.body = JSON.stringify(opts.json); headers['Content-Type'] = 'application/json'; }
    return doFetch(cfg.baseUrl.replace(/\/+$/, '') + path, init).then(function (r) {
      if (r.status === 204) return { status: 204, body: null };
      return r.json().catch(function () { return null; }).then(function (b) {
        if (r.ok) return { status: r.status, body: b };
        var err = b && b.error ? b.error : {};
        if (r.status === 401 && opts.auth !== false && session) { handleUnauthorized(); }
        throw fail(err.code || 'http_' + r.status, err.message || 'Request failed', { status: r.status });
      });
    });
  }
  function handleUnauthorized() {
    /* keep queued writes; they resume if the same account signs in again */
    var u = session && session.user;
    session = null; lsDel('session'); stopPolling(); cacheState = null; loadedFor = null;
    fire('bloomsync:authchange', { user: null, expired: true, previous: u });
  }

  var auth = {
    signup: function (email, password, name) { return authCall('/v1/auth/signup', { email: email, password: password, name: name || '' }); },
    login: function (email, password) { return authCall('/v1/auth/login', { email: email, password: password }); },
    logout: function () {
      var done = flush().catch(function () {}).then(function () { return session ? request('POST', '/v1/auth/logout').catch(function () {}) : null; });
      return done.then(function () {
        var id = uid();
        setSession(null);
        if (id) { lsDel('cache:' + id); dropQueue(id); }
      });
    },
    current: function () { return session && session.user ? clone(session.user) : null; },
    isSignedIn: function () { return !!session; }
  };
  function authCall(path, body) {
    return request('POST', path, { json: body, auth: false }).then(function (r) {
      setSession({ token: r.body.token, expiresAt: r.body.expiresAt, user: r.body.user });
      scheduleFlush(0);
      return clone(r.body.user);
    });
  }

  /* ---------- local cache: { cursor, docs: { 'col/id': { d, s } } } ---------- */
  var cacheState = null, loadedFor = null, persistTimer = null;
  function cache() {
    var id = uid();
    if (!id) return { cursor: 0, docs: {}, fresh: true };
    if (!cacheState || loadedFor !== id) {
      cacheState = lsGet('cache:' + id, null) || { cursor: 0, docs: {}, synced: false };
      loadedFor = id;
    }
    return cacheState;
  }
  function persistNow() {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    if (cacheState && loadedFor) lsSet('cache:' + loadedFor, cacheState); /* best effort: memory copy still works if storage is full */
  }
  function persistCache() {
    if (persistTimer) return;
    persistTimer = setTimeout(persistNow, 250);
  }
  function key(col, id) { return col + '/' + id; }

  /* ---------- write queue (persisted) ---------- */
  var queue = lsGet('queue', []); // [{ uid, op:'set'|'update'|'delete', col, id, data, n }]
  var inflight = null, flushing = null, flushTimer = null, backoffStep = 0, counter = 0;
  var waiters = new Map(); // op object -> [{resolve,reject}]
  function saveQueue() { lsSet('queue', queue); }
  function dropQueue(id) { queue = queue.filter(function (q) { return q.uid !== id; }); saveQueue(); }

  function enqueue(op, col, id, data) {
    var me = uid();
    if (!me) return Promise.reject(fail('unauthenticated', 'Not signed in'));
    var item = { uid: me, op: op, col: col, id: id, data: data === undefined ? undefined : clone(data), n: ++counter };
    /* coalesce with an earlier queued (not in-flight) op on the same document */
    var prior = null;
    for (var i = queue.length - 1; i >= 0; i--) { var q = queue[i]; if (q.uid === me && q.col === col && q.id === id) { prior = q; break; } }
    var p = new Promise(function (resolve, reject) {
      if (prior && prior !== inflight) {
        if (op === 'set' || op === 'delete') {
          queue.splice(queue.indexOf(prior), 1); mergeWaiters(prior, item); queue.push(item);
        } else if (op === 'update' && (prior.op === 'set' || prior.op === 'update')) {
          prior.data = Object.assign({}, prior.data, item.data); item = prior;
        } else queue.push(item);
      } else queue.push(item);
      var w = waiters.get(item) || []; w.push({ resolve: resolve, reject: reject }); waiters.set(item, w);
    });
    saveQueue();
    scheduleFlush(0);
    return p;
  }
  function mergeWaiters(from, to) { var a = waiters.get(from); if (a) { waiters.set(to, (waiters.get(to) || []).concat(a)); waiters.delete(from); } }
  function settle(item, err, value) {
    var w = waiters.get(item); waiters.delete(item);
    if (w) w.forEach(function (x) { if (err) x.reject(err); else x.resolve(value); });
  }
  function pending() { var me = uid(); return queue.filter(function (q) { return q.uid === me; }); }
  function hasPending(col, id) { var me = uid(); return queue.some(function (q) { return q.uid === me && q.col === col && q.id === id; }); }

  function scheduleFlush(ms) {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(function () { flushTimer = null; flush().catch(function () {}); }, ms);
  }
  function flush() {
    if (flushing) return flushing;
    flushing = (function step() {
      var me = uid();
      var item = me ? queue.filter(function (q) { return q.uid === me; })[0] : null;
      if (!item) { backoffStep = 0; return Promise.resolve(); }
      inflight = item;
      var path = '/v1/docs/' + encodeURIComponent(item.col) + '/' + encodeURIComponent(item.id);
      var req = item.op === 'set' ? request('PUT', path, { json: item.data })
        : item.op === 'update' ? request('PATCH', path, { json: item.data })
        : request('DELETE', path);
      return req.then(function (r) {
        inflight = null;
        queue.splice(queue.indexOf(item), 1); saveQueue();
        var c = cache();
        if (r.body && r.body.seq != null && c.docs[key(item.col, item.id)] && item.op !== 'delete') c.docs[key(item.col, item.id)].s = r.body.seq;
        settle(item, null, undefined);
        notify();
        return step();
      }, function (e) {
        inflight = null;
        var permanent = e && e.status && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 429 && e.status !== 408;
        if (permanent) {
          queue.splice(queue.indexOf(item), 1); saveQueue();
          if (e.status === 404 && item.op === 'update') { var c2 = cache(); delete c2.docs[key(item.col, item.id)]; persistCache(); }
          settle(item, e); notify();
          return step();
        }
        /* offline / server trouble / signed out: reject current waiters, keep the op, retry later */
        settle(item, e);
        backoffStep = Math.min(backoffStep + 1, 6);
        if (uid()) scheduleFlush(Math.min(300000, 3000 * Math.pow(2, backoffStep - 1)));
        throw e;
      });
    })().then(function (v) { flushing = null; return v; }, function (e) { flushing = null; throw e; });
    return flushing;
  }

  /* ---------- pull (incremental sync) ---------- */
  var pulling = null;
  function pull() {
    if (!uid()) return Promise.reject(fail('unauthenticated', 'Not signed in'));
    if (pulling) return pulling;
    var me = uid();
    pulling = (function loop() {
      var c = cache();
      return request('GET', '/v1/sync?since=' + c.cursor + '&limit=500').then(function (r) {
        if (uid() !== me) return;
        var b = r.body, changed = {};
        b.docs.forEach(function (d) {
          var k = key(d.collection, d.id);
          if (hasPending(d.collection, d.id)) return; /* a local write is on its way; it wins */
          if (d.deleted) { if (c.docs[k]) { delete c.docs[k]; changed[d.collection] = 1; } return; }
          var old = c.docs[k];
          if (!old || JSON.stringify(old.d) !== JSON.stringify(d.data)) changed[d.collection] = 1;
          c.docs[k] = { d: d.data, s: d.seq };
        });
        c.cursor = Math.max(c.cursor, b.cursor); c.synced = !b.hasMore ? true : c.synced;
        persistCache();
        notify(Object.keys(changed));
        return b.hasMore ? loop() : undefined;
      });
    })().then(function (v) { pulling = null; return v; }, function (e) { pulling = null; throw e; });
    return pulling;
  }

  /* ---------- polling + listeners ---------- */
  var listeners = []; // { col, field, dir, limit, next, err, started }
  var pollTimer = null;
  function visible() { try { return !root.document || root.document.visibilityState !== 'hidden'; } catch (e) { return true; } }
  function startPolling() {
    if (pollTimer || !listeners.length) return;
    pollTimer = setInterval(function () { if (visible() && uid()) tick(); }, cfg.pollMs);
  }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  function tick() { return flush().catch(function () {}).then(function () { return pull(); }).catch(function () {}); }
  try {
    if (root.addEventListener) {
      root.addEventListener('pagehide', persistNow);
      root.addEventListener('online', function () { if (uid()) tick(); });
      root.addEventListener('focus', function () { if (uid() && listeners.length) tick(); });
    }
    if (root.document && root.document.addEventListener) root.document.addEventListener('visibilitychange', function () { if (visible() && uid() && listeners.length) tick(); });
  } catch (e) {}

  function snapshotFor(l) {
    var c = cache(), rows = [], prefix = l.col + '/';
    Object.keys(c.docs).forEach(function (k) {
      if (k.indexOf(prefix) === 0) rows.push({ id: k.slice(prefix.length), d: c.docs[k].d, s: c.docs[k].s || 0 });
    });
    var f = l.field;
    rows.sort(function (a, b) {
      if (!f) return a.s - b.s || (a.id < b.id ? -1 : 1);
      var x = a.d[f], y = b.d[f];
      var r = x === y ? 0 : x == null ? -1 : y == null ? 1 : x < y ? -1 : 1;
      if (l.dir === 'desc') r = -r;
      return r || (a.id < b.id ? -1 : 1);
    });
    if (l.limit != null) rows = rows.slice(0, l.limit);
    var docs = rows.map(function (r) { return makeDocSnap(r.id, r.d); });
    return { docs: docs, size: docs.length, empty: !docs.length, forEach: function (fn) { docs.forEach(fn); } };
  }
  function emit(l) {
    if (l.dead) return;
    try { l.next(snapshotFor(l)); } catch (e) { try { console.error('BloomSync listener error', e); } catch (x) {} }
  }
  function notify(cols) {
    listeners.slice().forEach(function (l) { if (l.started && (!cols || cols.indexOf(l.col) >= 0 || cols === undefined)) emit(l); });
  }
  function addListener(l) {
    listeners.push(l);
    var me = uid();
    if (!me) { Promise.resolve().then(function () { if (!l.dead && l.err) l.err(fail('unauthenticated', 'Not signed in')); }); return unsubscribe(l); }
    startPolling();
    /* First emission waits for a server read, so an empty cache is never mistaken for an empty account.
       Offline, a cache that has synced before is used; otherwise the error callback fires and Bloom stays local. */
    flush().catch(function () {}).then(function () { return pull(); }).then(function () { first(l); }, function (e) {
      if (l.dead) return;
      if (cache().synced) first(l); else if (l.err) { try { l.err(e); } catch (x) {} }
    });
    return unsubscribe(l);
  }
  function first(l) { if (l.dead) return; l.started = true; emit(l); }
  function unsubscribe(l) {
    return function () { l.dead = true; var i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); if (!listeners.length) stopPolling(); };
  }

  /* ---------- Firestore-like facade ---------- */
  function makeDocSnap(id, data) {
    var snap = { id: id, exists: data !== undefined && data !== null, data: function () { return data == null ? undefined : clone(data); } };
    snap.ref = null;
    return snap;
  }

  function parsePath(path) {
    var m = /^data\/users\/([^/]+)\/([^/]+)$/.exec(String(path || ''));
    if (!m) throw fail('invalid-argument', 'Unsupported document path: ' + path);
    return { uid: m[1], name: m[2] };
  }
  function checkUser(id) { if (!uid() || id !== uid()) throw fail('permission-denied', 'Path belongs to a different user'); }

  function DocRef(col, id, ownerUid) { this.id = id; this._col = col; this._uid = ownerUid; }
  DocRef.prototype.get = function () {
    var self = this;
    return Promise.resolve().then(function () {
      checkUser(self._uid);
      return pull().catch(function (e) { if (!cache().synced) throw e; }); /* offline: fall back to the cache */
    }).then(function () {
      var e = cache().docs[key(self._col, self.id)];
      return makeDocSnap(self.id, e ? e.d : undefined);
    });
  };
  DocRef.prototype.set = function (data) {
    var self = this;
    return Promise.resolve().then(function () {
      checkUser(self._uid);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail('invalid-argument', 'set() needs an object');
      localApply(self._col, self.id, 'set', data);
      return enqueue('set', self._col, self.id, data);
    });
  };
  DocRef.prototype.update = function (data) {
    var self = this;
    return Promise.resolve().then(function () {
      checkUser(self._uid);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail('invalid-argument', 'update() needs an object');
      var e = cache().docs[key(self._col, self.id)];
      if (!e && !hasPending(self._col, self.id)) { /* unknown locally: let the server decide */ return enqueue('update', self._col, self.id, data); }
      localApply(self._col, self.id, 'update', data);
      return enqueue('update', self._col, self.id, data);
    });
  };
  DocRef.prototype.delete = function () {
    var self = this;
    return Promise.resolve().then(function () {
      checkUser(self._uid);
      localApply(self._col, self.id, 'delete');
      return enqueue('delete', self._col, self.id);
    });
  };
  DocRef.prototype.collection = function (name) {
    if (this._col !== ROOT_COL) throw fail('invalid-argument', 'Nested collections are not supported');
    return new Query(String(name), this._uid, null, null, null);
  };

  function localApply(col, id, op, data) {
    var c = cache(), k = key(col, id);
    if (op === 'delete') delete c.docs[k];
    else if (op === 'set') c.docs[k] = { d: clone(data), s: (c.docs[k] && c.docs[k].s) || 0 };
    else if (c.docs[k]) c.docs[k] = { d: Object.assign({}, c.docs[k].d, clone(data)), s: c.docs[k].s };
    persistCache();
    var cols = [col];
    setTimeout(function () { notify(cols); }, 0); /* like Firestore: local writes fire snapshots right away */
  }

  function Query(col, ownerUid, field, dir, limit) { this._col = col; this._uid = ownerUid; this._field = field; this._dir = dir; this._limit = limit; }
  Query.prototype.doc = function (id) {
    if (typeof id !== 'string' || !id) throw fail('invalid-argument', 'doc() needs an id');
    return new DocRef(this._col, id, this._uid);
  };
  Query.prototype.orderBy = function (field, dir) { return new Query(this._col, this._uid, field, dir === 'desc' ? 'desc' : 'asc', this._limit); };
  Query.prototype.limit = function (n) { return new Query(this._col, this._uid, this._field, this._dir, n); };
  Query.prototype.onSnapshot = function (next, err) {
    var self = this;
    try { checkUser(this._uid); } catch (e) { Promise.resolve().then(function () { if (err) err(e); }); return function () {}; }
    return addListener({ col: self._col, field: self._field, dir: self._dir, limit: self._limit, next: next, err: err, started: false, dead: false });
  };
  Query.prototype.get = function () {
    var self = this;
    return Promise.resolve().then(function () {
      checkUser(self._uid);
      return pull().catch(function (e) { if (!cache().synced) throw e; });
    }).then(function () { return snapshotFor({ col: self._col, field: self._field, dir: self._dir, limit: self._limit }); });
  };

  var db = {
    doc: function (path) {
      var p = parsePath(path);
      return new DocRef(ROOT_COL, p.name, p.uid);
    }
  };
  var user = {
    id: function () { return Promise.resolve(uid()); },
    current: function () { return auth.current(); }
  };

  /* ---------- public API ---------- */
  root.BloomSync = {
    configure: function (o) {
      o = o || {};
      if (typeof o.baseUrl === 'string') cfg.baseUrl = o.baseUrl;
      if (o.pollMs > 0) cfg.pollMs = o.pollMs;
      if (typeof o.fetch === 'function') cfg.fetch = o.fetch;
      if (pollTimer) { stopPolling(); startPolling(); }
      return this;
    },
    auth: auth,
    use: function (name) {
      if (name === 'db') return Promise.resolve(db);
      if (name === 'user') return Promise.resolve(user);
      return Promise.reject(fail('unsupported', 'BloomSync does not provide "' + name + '"'));
    },
    /* True once a baseUrl is set and someone is signed in; Bloom can use this to prefer BloomSync over window.claude. */
    isActive: function () { return !!cfg.baseUrl && !!session; },
    /* Number of writes not yet acknowledged by the server. */
    pendingWrites: function () { return pending().length; },
    syncNow: function () { return tick(); },
    /* test hook: forget in-memory state (not storage) */
    _reset: function () { persistNow(); stopPolling(); listeners = []; cacheState = null; loadedFor = null; pulling = null; flushing = null; inflight = null; if (flushTimer) clearTimeout(flushTimer); flushTimer = null; waiters = new Map(); session = lsGet('session', null); queue = lsGet('queue', []); }
  };
})(typeof window !== 'undefined' ? window : globalThis);
