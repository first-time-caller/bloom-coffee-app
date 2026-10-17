/** Browser implementations of the injected dependencies. The only file that touches window/localStorage/IndexedDB. */
import type { Deps, FetchLike, KeyStore, Lifecycle, KV } from './types.ts';

/** Test/embedding overrides, set through BloomSync.configure({ fetch, keyStore }). */
export interface Overrides { fetch?: FetchLike; keyStore?: KeyStore }

export function webStorage(w: any): KV {
  const ls = () => { try { return w.localStorage || null; } catch { return null; } };
  return {
    async get(k) { const s = ls(); return s ? s.getItem(k) : null; },
    async set(k, v) { const s = ls(); if (!s) throw new Error('storage unavailable'); s.setItem(k, v); },
    async remove(k) { const s = ls(); if (s) s.removeItem(k); }
  };
}

/**
 * "Stay signed in": the data key is kept as a NON-EXTRACTABLE CryptoKey in IndexedDB. Script on the page (e.g. an XSS)
 * can still ask the browser to use it while the page is open, but it cannot read the key bytes or copy them to a server,
 * and clearing site data / logging out removes it. If IndexedDB is unavailable the key lives in memory only and the
 * session is "locked" after a reload (the password unlocks it).
 */
export function idbKeyStore(w: any): KeyStore | undefined {
  if (!w.indexedDB) return undefined;
  const open = () => new Promise<IDBDatabase>((res, rej) => {
    const r = w.indexedDB.open('bloomsync-keys', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('keys'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((res, rej) => {
        const tx = db.transaction('keys', mode);
        const rq = fn(tx.objectStore('keys'));
        tx.oncomplete = () => res(rq.result);
        tx.onerror = tx.onabort = () => rej(tx.error);
      });
    } finally { db.close(); }
  };
  return {
    async save(uid, key) { await run('readwrite', s => s.put(key, uid)); },
    async load(uid) { const k = await run<any>('readonly', s => s.get(uid)); return k && typeof k === 'object' && k.type === 'secret' ? (k as CryptoKey) : null; },
    async clear(uid) { await run('readwrite', s => s.delete(uid)); }
  };
}

export function webLifecycle(w: any): Lifecycle {
  const on = (target: any, ev: string, cb: () => void) => {
    if (!target || !target.addEventListener) return () => {};
    target.addEventListener(ev, cb);
    return () => target.removeEventListener(ev, cb);
  };
  const doc = w.document;
  return {
    isVisible: () => { try { return !doc || doc.visibilityState !== 'hidden'; } catch { return true; } },
    onOnline: cb => on(w, 'online', cb),
    onVisible: cb => {
      const a = on(w, 'focus', cb), b = on(doc, 'visibilitychange', () => { if (!doc || doc.visibilityState !== 'hidden') cb(); });
      return () => { a(); b(); };
    },
    onHide: cb => on(w, 'pagehide', cb)
  };
}

export function webDeps(w: any, over: Overrides = {}): Deps {
  const idb = idbKeyStore(w);
  return {
    storage: webStorage(w),
    fetch: (url, init) => (over.fetch ? over.fetch(url, init) : w.fetch(url, init)),
    crypto: w.crypto,
    clock: {
      now: () => Date.now(),
      setTimeout: (fn, ms) => w.setTimeout(fn, ms),
      clearTimeout: h => w.clearTimeout(h as number),
      setInterval: (fn, ms) => w.setInterval(fn, ms),
      clearInterval: h => w.clearInterval(h as number)
    },
    lifecycle: webLifecycle(w),
    get keyStore() { return over.keyStore ?? idb; },
    emit: (name, detail) => { if (w.dispatchEvent && typeof w.CustomEvent === 'function') w.dispatchEvent(new w.CustomEvent(name, { detail })); },
    abort: () => { if (typeof w.AbortController !== 'function') return { signal: undefined, abort() {} }; const c = new w.AbortController(); return { signal: c.signal, abort: () => c.abort() }; },
    log: (...a) => { try { w.console.error(...a); } catch { /* ignore */ } }
  };
}
