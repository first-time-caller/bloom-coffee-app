# Bloom: espresso and GaggiMate plan

## Architecture

- **web/** The Bloom single-page app (`web/index.html`), plain HTML/CSS/JS with no build step. It is local-first (`localStorage`), with sync through a pluggable backend adapter. Built JS libraries go in `web/vendor/`.
- **packages/contract/** Shared TypeScript types. This is the source of truth for data shapes.
- **packages/slog/** A TypeScript parser for GaggiMate `.slog` shot files and `index.bin`. It builds to `web/vendor/bloom-slog.js`, which exposes `window.BloomSlog`.
- **backend/** Cloudflare Workers, Hono and D1. It handles accounts and document sync, and stores raw shot files.
- **app/** (phase B) A Capacitor shell for iOS and Android. It talks to the GaggiMate over the LAN and syncs to the backend.

The browser cannot reach the machine (plain http, no CORS). Only the native app talks to the GaggiMate. The web app keeps manual espresso entry.

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
3. The Capacitor shell, a local machine connection, and shot import (app/).
4. The backend, accounts, and sync (backend/, plus the web adapter).
5. A live brewing view and profile selection.

Phase A runs steps 1, 2 and 4 in parallel. Phase B runs steps 3 and 5 after A is integrated.
