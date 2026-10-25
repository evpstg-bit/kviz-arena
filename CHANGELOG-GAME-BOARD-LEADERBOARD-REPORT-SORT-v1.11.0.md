# Version 1.11.0 — board sizing, Classic leaderboard, report sorting

- Color Kingdoms scales the board based on the active group size: 9×9 up to 10 players, 11×11 up to 20, 15×15 up to 35, 17×17 up to 60, and 19×19 for larger groups. For 30 players the board is 15×15.
- The board uses an adaptive width limited by available layout space and viewport height, with smaller cell glyphs on narrow screens.
- Added a live top-five leaderboard for Classic hosts, between host action controls and the participant statistics panel. It updates with live scores and correct-answer tie-breaks.
- Added sorting on the report Questions tab: original quiz order, highest success percentage first, or lowest first. Equal percentages keep the original question order.
- Updated static asset cache-busting versions and package version to 1.11.0.

## Validation

- `node --check server.js` passed.
- Inline JavaScript blocks in `public/index.html` passed `node --check`.
- Project JSON files parsed successfully.
- HTTP smoke checks and stylesheet syntax checks performed locally; full visual/device testing should still be performed after deployment.
