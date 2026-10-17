# Bloom backend

Cloudflare Workers + Hono + D1. Accounts (email + password) and a per-user document store that mirrors Bloom's
Firestore-style paths, plus raw `.slog` shot storage. The client is `../packages/sync` (built to `../web/bloom-sync.js`; run `npm run build` there before the adapter tests).

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

The server is a **ciphertext store**: it never receives a password, master key, key-encryption key, data key or recovery key, and
refuses document or shot bodies that are not encrypted envelopes. All crypto is client side (`../packages/sync/README.md` has the
key hierarchy and formats). Bodies are JSON and strict (unknown fields, including a stray `password`, give 422). Errors:
`{ "error": { "code", "message" } }` with 400 invalid JSON, 401 unauthorized / invalid_credentials, 404 not_found, 409 email_taken /
conflict / quota_exceeded / legacy_account, 413 too_large, 415 unsupported_media_type, 422 validation_failed, 429 rate_limited.

| Method and path | Notes |
| --- | --- |
| `POST /v1/auth/prelogin` `{email}` | `{alg:'pbkdf2-sha256', iterations, salt}`. Unknown emails get deterministic decoy parameters (HMAC of the email under `PRELOGIN_SECRET`, or a secret generated into `server_config`), so account existence is not revealed. |
| `POST /v1/auth/signup` `{email,name?,authKey,kdf,wrappedDek,recoveryWrappedDek,recoveryAuth}` | 201 `{token, expiresAt, user}`. `kdf.iterations` must be at least 600,000 (`MIN_KDF_ITERATIONS` lowers it for tests only). |
| `POST /v1/auth/login` `{email,authKey}` | 200 `{token, expiresAt, user, kdf, wrappedDek}` |
| `GET /v1/auth/keys` | `{kdf, wrappedDek, keyVersion}` for the signed-in user (unlock, change password) |
| `POST /v1/auth/change-password` `{currentAuthKey,newAuthKey,kdf,wrappedDek}` | 204. Verifies the current authKey, swaps credentials in one transaction, signs out every other session. |
| `POST /v1/auth/recover` `{email,recoveryAuth}` | Step 1: returns `{recoveryWrappedDek, kdf}` if `recoveryAuth` matches. Same body plus `{authKey,kdf,wrappedDek}` is step 2: replaces the credentials, revokes all sessions, returns a new session like login. |
| `POST /v1/auth/logout` | 204, revokes this token |
| `GET /v1/me` | `{id,email,name,createdAt}` |
| `GET /v1/sync?since=<seq>&limit=<1..500>&collection=<name>` | Changes after `seq`, ordered by seq: `{docs:[{collection,id,data,deleted,updatedAt,seq}], cursor, hasMore}`; `data` is the encrypted envelope. `since=0` omits tombstones. |
| `GET /v1/docs/:collection/:id` | `{collection,id,data,updatedAt,seq}` or 404 |
| `PUT /v1/docs/:collection/:id[?baseSeq=N]` | Body must be an envelope `{v:1,iv,ct}` (256 KB max). Without `baseSeq`: last write wins. With it: compare-and-swap, 409 `conflict` unless the live doc's seq is still N (0 = must not exist; a tombstone counts as not existing). |
| `DELETE /v1/docs/:collection/:id` | Leaves a server tombstone. Idempotent, 204. (The Bloom client writes encrypted tombstones with a clock stamp instead, so deletes merge field-level; see packages/sync.) |
| `PUT /v1/shots/:machineId/:shotId` | Body: `"BSE\x01"|iv|ciphertext` (client-encrypted `.slog`), `application/octet-stream`, at most 1 MiB + 64. Plaintext is rejected (422) and so is `X-Shot-Meta`. Idempotent upsert; 201 / 200. |
| `GET /v1/shots?machineId=&limit=&before=` | Ids, size and timestamps only, newest first. |
| `GET /v1/shots/:machineId/:shotId` | Ciphertext bytes |
| `DELETE /v1/shots/:machineId/:shotId` | 204 |

There is no `PATCH`: the server cannot merge ciphertext, so merging happens on the client, guarded by `baseSeq`.
Names: collection `[A-Za-z0-9_-]{1,64}`, doc/machine/shot ids `[A-Za-z0-9_.-]{1,128}`.
Authentication is `Authorization: Bearer <token>`. Accounts created before E2E (no wrapped key) get 409 `legacy_account` on login.

### Sync model

Every write (put, delete) increments the user's `seq` and stamps the document with it, in one D1 batch. A conditional write does
its check and the write in one SQL statement, so racing writers cannot both win (the loser still bumps `seq`; gaps are harmless).
`updatedAt` is the server clock and informational. Caps: 256 KB per doc, 20,000 live docs per user, 5,000 shots per user.

### D1 schema (`migrations/0001_init.sql`, `0002_e2ee.sql`)

- `users(id, email unique lowercased, name, pw_hash, seq, created_at)`
- `sessions(token_hash pk, user_id, created_at, last_used_at, expires_at)`
- `docs(user_id, collection, id, data json|null, deleted, updated_at, seq)` pk `(user_id, collection, id)`, index `(user_id, seq)`
- `shots(user_id, machine_id, shot_id, data blob, size, meta json, created_at, updated_at)`
- `rate_limits(key pk, window_start, count)`
- `0002_e2ee.sql` (additive): `users.kdf_alg/kdf_iterations/kdf_salt/wrapped_dek/recovery_wrapped_dek/recovery_hash/key_version`, and `server_config(key, value)`. `docs.data` now holds envelopes; `shots.meta` is no longer written.

## Security notes

- The password never arrives. The client sends `authKey` (HKDF of a 600k-round PBKDF2 master key); the server hashes that with PBKDF2-SHA256, 100,000 iterations (the maximum Workers' WebCrypto allows), 16-byte random salt, stored as
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

- Password reset is by recovery key only (no email provider); no email verification yet.
- No account deletion endpoint.
- Rate limiting is per-D1-row and approximate; for serious abuse protection add Cloudflare's rate limiting rules.
- The doc quota check is read-then-write, so concurrent requests can overshoot it slightly.
- The server-side hash is 100k rounds (Workers' cap) but it protects a high-entropy authKey; the 600k-round stretching of the password happens on the client.
- `@cloudflare/vitest-pool-workers` is deprecated in favour of `@cloudflare/vitest-plugin`; it is pinned and works, migrate when convenient.
- Not exercised against a deployed Worker or remote D1, only local workerd/D1.
