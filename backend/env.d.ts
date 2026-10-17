declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    ALLOWED_ORIGINS?: string;
    AUTH_RATE_LIMIT?: string;
    MIGRATIONS: D1Migration[];
  }
}
