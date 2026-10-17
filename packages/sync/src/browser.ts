/**
 * Browser entry: builds web/bloom-sync.js (IIFE). Exposes window.BloomSync with the same public API as the original
 * hand-written adapter (configure, auth.*, use('db'|'user'), isActive, pendingWrites, syncNow) plus the key/account
 * functions (auth.unlock/recover/changePassword, status, shots, planUpload).
 */
import { createSync } from './client.ts';
import { planUpload } from './util.ts';
import { webDeps, type Overrides } from './web-platform.ts';

const w = globalThis as any;
const over: Overrides = {};
const api = createSync(webDeps(w, over));
const configure = api.configure;
// The original adapter accepted { fetch } (used by tests and embedders); keep that, and allow a custom key store.
api.configure = (o: any = {}) => {
  if (typeof o.fetch === 'function') over.fetch = o.fetch;
  if (o.keyStore) over.keyStore = o.keyStore;
  return configure(o);
};
w.BloomSync = Object.assign(api, {
  planUpload,
  /** False on insecure origins (no WebCrypto): Bloom stays local-only there. */
  supported: !!(w.crypto && w.crypto.subtle)
});
