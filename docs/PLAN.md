# Bloom: espresso and GaggiMate plan

## Architecture

- **web/** The Bloom single-page app (`web/index.html`), plain HTML/CSS/JS with no build step. It is local-first (`localStorage`), with sync through a pluggable backend adapter. Built JS libraries go in `web/vendor/`.
- **packages/contract/** Shared TypeScript types. This is the source of truth for data shapes.
- **packages/slog/** A TypeScript parser for GaggiMate `.slog` shot files and `index.bin`. It builds to `web/vendor/bloom-slog.js`, which exposes `window.BloomSlog`.
- **backend/** Cloudflare Workers, Hono and D1. It handles accounts and document sync, and stores raw shot files.
- **app/** (phase B) A React Native (Expo) app with native UI for iOS and Android. It reuses `packages/contract`, `packages/slog` and `packages/sync`, talks to the GaggiMate over the LAN, and syncs to the backend.
- **packages/sync/** A platform-neutral TypeScript sync and crypto core. It builds to `web/bloom-sync.js` for the web app and is imported directly by the mobile app.

The browser cannot reach the machine (plain http, no CORS). Only the native app talks to the GaggiMate. The web app keeps manual espresso entry.

## Principles (enforced by CI gates, see QUALITY-GATES.md)

- **Local-first and private.** Data is end-to-end encrypted: the server stores only ciphertext. There are no third-party requests or trackers, and data collection is kept to a minimum.
- **Native UI on mobile.** No web wrappers.
- **Reliability and performance.** Tests, coverage, migration safety, bundle and performance budgets, no memory leaks, deterministic state restoration, and full accessibility (Dynamic Type and font scaling, screen readers, high contrast, dark mode).

## GaggiMate facts (verified from source)

- Live data uses the WebSocket `ws://<host>/ws`. JSON messages are identified by the `tp` field. `evt:status` arrives about every 500 ms with `ct`, `tt`, `pr`, `pt`, `fl`, `m`, `p`, and frames are partial.
- Shot index: `GET /api/history/index.bin`, or `GET /api/history/recent.bin?limit=N` (N from 1 to 50).
- A single shot: `GET /api/history/<id padded to 6 digits>.slog`.
- Notes are read and written over the WebSocket with `req:history:notes:get` and `req:history:notes:save` (`{id, notes}`), and the response echoes `rid`.
- The format is defined in `src/display/models/shot_log_format.h`. There is a layout test in `test/test_shot_log_layout`.
- A reference clone is at `/tmp/claude-0/ref/gaggimate`. **License: CC BY-NC-SA 4.0.** Use it as a specification and a test oracle only. Do not copy its code into Bloom.

## Work order

1. The `.slog` and index parser, with tests (packages/slog).
2. Espresso mode in the web app, using sample data (web/).
3. The React Native (Expo) app, a local machine connection, and shot import (app/).
4. The backend, accounts, and sync (backend/, plus the web adapter). Then end-to-end encryption (packages/sync).
5. A live brewing view and profile selection.

Phase A runs steps 1, 2 and 4 in parallel. Phase B runs steps 3 and 5 after A is integrated.

## Requirements carried into later phases

**Sync (in progress)**
- Conflicts merge field by field inside the encrypted payload, using hybrid logical clocks. Blind last-write-wins on device timestamps is not used, because skewed clocks would lose edits. The server only orders writes with `seq` and rejects stale writes with 409.

**Mobile (Expo)**
- Live machine data comes over wifi (the WebSocket), not phone Bluetooth. The scale pairs with the GaggiMate, and the machine records every shot itself. If the app is backgrounded mid-shot, only the live view pauses. On return, the app reconnects and imports the full `.slog`, so no data is lost. Do **not** add background modes or foreground services for this path.
- If phone-to-scale Bluetooth is ever added (for example pour-over with an Acaia), it needs a development build with a BLE config plugin. iOS needs the `bluetooth-central` background mode with a justification for App Review. Android 14+ needs a foreground service of type `connectedDevice` with a visible notification. Brew state must still be restorable from timestamps rather than relying on staying alive.
- Machine import:
  - De-duplicate by machineId, shotId and startedAt (ids restart after a reflash).
  - Warn when the machine's history is close to rotating out un-imported shots.
  - Handle firmware or format versions the parser doesn't support with a clear message, never a crash.
- Remote brew start ships last, behind an explicit on-screen confirmation and a safety notice. Read-only comes first.
- App Review needs a demo mode with sample shots, because reviewers have no GaggiMate.
- Crypto on mobile uses platform-provided standard algorithms (AES-GCM, PBKDF2 and HKDF via the OS or a vetted WebCrypto implementation). Nothing custom.

**Purchases**
- See BUSINESS.md. The brew gate fails open: a store outage, a network failure or a verification error never blocks a brew.

**Accounts**
- Email verification at sign-up.
- Account deletion is available in the app while signed in.
- Deletion with a forgotten password: an emailed confirmation link starts the deletion, followed by a 7-day cancellable cooling-off period. Any signed-in device can cancel it. The recovery key also proves ownership.

## Backlog from the product review

**Phase B (Expo app)**
- Parser failures go through one wrapper. An unsupported firmware or format version gets a calm "This firmware's shot format isn't supported yet" message. The raw file is kept, so it can be re-parsed after an update, and summary fields from the index are still shown. The app never crashes.
- Real exported shots from the developer's machine become the primary CI fixtures, alongside the synthetic ones.
- A "connect soon" banner appears when the machine hasn't been reached for 7 days, and earlier if the machine's history is nearly full.
- Shot identity: the dedupe key is `machineId + shotId + startedAt (UTC)`. If the machine clock was never synced (`startedAt` before 2020), the import time is used for display and the raw values are kept, so the key stays stable when the shot is imported again.
- Local-only machine link: the app refuses machine addresses that aren't private, link-local or `.local` (RFC 1918, RFC 4193, 169.254/16 and mDNS). Settings shows a note that the machine has no password and must never be exposed to the internet.
- Opt-in crash reports: after a crash, the next launch asks once. If the user agrees, a scrubbed report goes to `POST /v1/errors` on our Worker, in a separate D1 table with 30-day retention. The report holds the error type, a stack trace with paths stripped, the app and OS version, and nothing else: no ids, keys, tokens or user content. It is rate limited.
- Local SQLite on device for history, search and stats, since the server can't search ciphertext.
- On-device label scanning with Apple Vision and Google ML Kit text recognition.
- Demo mode is shown on the sign-in screen and uses sample shots and a simulated machine. It is not a hidden flag, so reviewers and curious users can find it.
- Account deletion is visible under Settings → Account.
- Every UI string lives in the i18n catalogue from day one, and units (g/oz, °C/°F) follow the user's setting everywhere, including charts.

**Web**
- The espresso chart must respect the existing unit setting (°F), because it currently always shows °C.
- Add an importer for the legacy JSON export from the hosted claude.ai Bloom (Settings → Your data → Export), plus a short migration page.
- The web app stays fully featured for pour-over until the Expo app reaches parity. After that it becomes the companion: account, import and export, desktop shot analysis, and web purchase.

**Backend**
- Email verification and a self-hosted proof-of-work challenge on sign-up, on top of rate limits. Cloudflare Turnstile is avoided because it loads a third-party script, which fails the privacy gate.
- Backups: D1 Time Travel, plus a scheduled encrypted `wrangler d1 export` to R2 or offsite storage, with a restore drill documented.
- Support is self-service only for lost keys; the operator cannot recover data, by design. The support address is support@<domain>.

**Phase C (broaden the market)**
- Phone-to-scale Bluetooth for pour-over and manual espresso (Acaia and Felicita). Check the licensing of any reverse-engineered protocol library before use.
- Export to Visualizer.coffee: a file export first. Upload through their API only when the user explicitly asks, with their own credentials, and disclosed as a third party.
- Recipe sharing with public-key encryption to a friend's key.
- More machines: La Marzocco (cloud API) and Decent, Meticulous and Gaggiuino (local APIs).

**Owner actions (not code)**
- Contact the GaggiMate maintainer about partnership or revenue share, and get written consent before using the name in marketing.
- Commission a human cryptography review before advertising end-to-end encryption.
- Run a trademark search for "Bloom".
