# Changelog

## Unreleased

- Added multi-channel `ConversationRuntime` with a shared `EventBus` and append-only event log.
- Routed PWA, scheduled jobs, Telegram, and iMessage conversation turns through the runtime boundary.
- Added runtime lifecycle WebSocket events for PWA status/tool/response updates.
- Added `src/test.js` runtime smoke tests covering event ordering, command handling, and HTTP/WebSocket flow.
- Kept the public package provider-neutral by removing old self-healing and provider-specific references from touched runtime/channel files.

## v1.0.0 - 2026-05-05

- WebSocket support for PWA (persistent bidirectional connection, replaces HTTP POST).
- AG-UI activity streaming (real-time tool call visibility with dynamic descriptions).
- Steering (send messages while Cal is processing, injected between tool iterations).
- Web Push notifications (VAPID-based, desktop — iOS requires HTTPS).
- Multi-client WebSocket (multiple devices connect simultaneously).
- Service worker v2 with push + notificationclick handlers.
- No-cache headers on HTML/JS to prevent stale service worker issues.
- New file: `src/web-push.js` (subscription CRUD, VAPID key management, push delivery).
- Gateway routing: proactive messages go to WebSocket (if connected) or Web Push (if not).
- Public-safe runtime config loading with optional profile overlays.
- Telegram as an optional channel.
- iMessage skips gracefully when not running on macOS or when local messaging tools are unavailable.
- Public audit checks for runtime config, credentials, private data, and organization-specific references.
