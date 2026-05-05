# Changelog

## Unreleased

- Added WebSocket support for PWA (persistent bidirectional connection, replaces HTTP POST).
- Added AG-UI activity streaming (real-time tool call visibility with dynamic descriptions).
- Added steering (send messages while Cal is processing, injected between tool iterations).
- Added Web Push notifications (VAPID-based, desktop — iOS requires HTTPS).
- Multi-client WebSocket (multiple devices connect simultaneously).
- Service worker v2 with push + notificationclick handlers.
- No-cache headers on HTML/JS to prevent stale service worker issues.
- New file: `src/web-push.js` (subscription CRUD, VAPID key management, push delivery).
- Gateway routing: proactive messages go to WebSocket (if connected) or Web Push (if not).
- Prepared the public distribution with example-only configuration and no runtime state.
- Added public-safe runtime config loading with optional profile overlays.
- Added Telegram as an optional public channel.
- Added disabled-by-default Auto Heal review examples for proposal-only repair workflows.
- Made iMessage skip gracefully when not running on macOS or when local messaging tools are unavailable.
- Added public audit checks for runtime config, credentials, private data, and organization-specific references.

