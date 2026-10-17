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
