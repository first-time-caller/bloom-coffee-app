# Bloom backend

Cloudflare Workers + Hono + D1. Accounts (email + password) and a per-user document store that mirrors Bloom's
Firestore-style paths, plus raw `.slog` shot storage. The browser adapter is `../web/bloom-sync.js`.

## Setup

```sh
cd backend
npm install                         # .npmrc sets legacy-peer-deps (the vitest pool declares a strict vitest peer)
npx wrangler d1 create bloom        # prints a database_id: paste it into wrangler.toml
npm run db:migrate:local            # local D1 for `wrangler dev`
npm run dev                         # http://localhost:8787
npm test                            # vitest in workerd with a real local D1, migrations applied; works offline
```

Deploy:

```sh
npm run db:migrate:remote
npx wrangler deploy
```

Set `ALLOWED_ORIGINS` (comma-separated, in `wrangler.toml` `[vars]` or the dashboard) to the origin(s) serving the
web app. `capacitor://localhost`, `http://localhost` and `https://localhost` are always allowed.
`AUTH_RATE_LIMIT` (default 20 attempts per 15 min per IP and per email) is optional.

## API

All bodies are JSON unless noted. Errors: `{ "error": { "code", "message" } }` with 400 invalid JSON, 401 unauthorized /
invalid_credentials, 404 not_found, 409 email_taken / quota_exceeded, 413 too_large, 415 unsupported_media_type,
422 validation_failed, 429 rate_limited.

| Method and path | Notes |
| --- | --- |
| `POST /v1/auth/signup` `{email,password,name}` | 201 `{token, expiresAt, user}`. Password 8 to 200 chars. |
| `POST /v1/auth/login` `{email,password}` | 200 `{token, expiresAt, user}` |
| `POST /v1/auth/logout` | 204, revokes this token |
| `GET /v1/me` | `{id,email,name,createdAt}` |
| `GET /v1/sync?since=<seq>&limit=<1..500>&collection=<name>` | Changes after `seq`, ordered by seq: `{docs:[{collection,id,data,deleted,updatedAt,seq}], cursor, hasMore}`. Pass `cursor` next time; loop while `hasMore`. `since=0` omits tombstones. |
| `GET /v1/docs/:collection/:id` | `{collection,id,data,updatedAt,seq}` or 404 |
| `PUT /v1/docs/:collection/:id` | Replace or create. Body is a JSON object, at most 256 KB. |
| `PATCH /v1/docs/:collection/:id` | Shallow merge of top-level keys. 404 if the doc does not exist. |
| `DELETE /v1/docs/:collection/:id` | Leaves a tombstone. Idempotent, 204. |
| `PUT /v1/shots/:machineId/:shotId` | Body: raw bytes, `Content-Type: application/octet-stream`, at most 1 MB. Optional `X-Shot-Meta` header: JSON object (at most 8 KB) with a parsed summary. Idempotent upsert; 201 on create, 200 on replace. |
| `GET /v1/shots?machineId=&limit=&before=` | Metadata only, newest first. |
| `GET /v1/shots/:machineId/:shotId` | Raw bytes (meta echoed in `X-Shot-Meta`). |
| `DELETE /v1/shots/:machineId/:shotId` | 204 |

Names: collection `[A-Za-z0-9_-]{1,64}`, doc/machine/shot ids `[A-Za-z0-9_.-]{1,128}`.
Authentication is `Authorization: Bearer <token>`.

### Sync model

Every write (put, patch, delete) increments the user's `seq` and stamps the document with it, in one D1 batch, so a
client that remembers the highest `seq` it has seen can fetch exactly what changed. Conflict policy is
**last write wins per document** (server arrival order); there is no field-level merging except the shallow
`PATCH`. `updatedAt` is the server clock and is informational; Bloom's own `updatedAt` fields inside the document
bodies are untouched. Caps: 256 KB per doc, 20,000 live docs per user, 5,000 shots per user.

### D1 schema (`migrations/0001_init.sql`)

- `users(id, email unique lowercased, name, pw_hash, seq, created_at)`
- `sessions(token_hash pk, user_id, created_at, last_used_at, expires_at)`
- `docs(user_id, collection, id, data json|null, deleted, updated_at, seq)` pk `(user_id, collection, id)`, index `(user_id, seq)`
- `shots(user_id, machine_id, shot_id, data blob, size, meta json, created_at, updated_at)`
- `rate_limits(key pk, window_start, count)`

## Security notes

- Passwords: PBKDF2-SHA256, 100,000 iterations (the maximum Workers' WebCrypto allows), 16-byte random salt, stored as
  `pbkdf2$sha256$iters$salt$hash`; constant-time compare; unknown emails burn the same CPU as known ones.
- Sessions: 256-bit random opaque tokens; only the SHA-256 is stored. 30-day expiry that slides on use (refreshed at
  most hourly). Logout deletes the row.
- Every document and shot query includes `user_id` from the session, never from the request.
- Auth endpoints are rate limited per IP and per email with a fixed-window counter in D1.
- Inputs validated with zod; body sizes are enforced on the bytes actually read, not just `Content-Length`.
- CORS is an allow-list; responses are `no-store` and `nosniff`. Tokens are bearer headers, not cookies, so there is no CSRF surface.

## Later: magic links and passkeys

Identity is the `users` row and sessions are independent of how you proved identity. Magic links: add a
`login_tokens(hash, user_id, expires_at)` table, a mail provider call, and an endpoint that exchanges the token for a
session via `createSession` in `src/auth.ts`. Passkeys: add a `credentials(user_id, credential_id, public_key, counter)` table
and WebAuthn register/assert endpoints that end in the same `createSession`; make `pw_hash` nullable for such accounts.

## Known limitations

- No password reset or email verification yet (needs an email provider).
- No account deletion endpoint.
- Rate limiting is per-D1-row and approximate; for serious abuse protection add Cloudflare's rate limiting rules.
- The doc quota check is read-then-write, so concurrent requests can overshoot it slightly.
- PBKDF2 at 100k iterations is below current OWASP guidance (600k); Workers does not allow more. Consider Argon2 via WASM later.
- `@cloudflare/vitest-pool-workers` is deprecated in favour of `@cloudflare/vitest-plugin`; it is pinned and works, migrate when convenient.
- Not exercised against a deployed Worker or remote D1, only local workerd/D1.
