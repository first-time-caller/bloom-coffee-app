declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    ALLOWED_ORIGINS?: string;
    AUTH_RATE_LIMIT?: string;
    PRELOGIN_SECRET?: string;
    MIN_KDF_ITERATIONS?: string;
    MIGRATIONS: D1Migration[];
  }
}

/** web/bloom-sync.js is the browser build of packages/sync (an IIFE with no exports); tests load it for its side effect. */
declare module '*bloom-sync.js';
