# Color Kingdoms start/crash fix — v1.11.3

- Hardened Server-Sent Events broadcasts: a closed or slow client connection can no longer throw out of the shared broadcast loop and bring down an active in-memory game.
- Added defensive error handling for initial SSE state, heartbeats, per-player updates, and Color Kingdoms startup.
- A startup failure is logged with context and returned as a useful response while retaining the room in the lobby when possible.
- The host lobby now displays the error returned by the server instead of silently ignoring it.
- SSE reconnect handling now captures the individual EventSource instance, ignores stale callbacks, and rechecks missing-room responses before sending players back home.
- Package version updated to 1.11.3.

## Validation

- `node --check server.js` passed.
- All inline JavaScript blocks extracted from `public/index.html` passed `node --check`.
- `package.json`, `app-settings.json`, `builtin-tests.json`, and `admin-credentials.json` parsed successfully.
- Local integration test: create a Color Kingdoms room, connect 30 participants, drop a subset of SSE connections, start the match, and confirm the room remains alive and emits `state=playing`.
- HTTP smoke checks for `/`, `/api/info`, and `/responsive-v2.css` passed.
- ZIP archive integrity checked.

A full visual test in a real browser/device and a live Render deployment test were not performed.
