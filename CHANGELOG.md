# Changelog

## Unreleased

- Added `save_last_assistant_response` so save/export requests can copy prior assistant text from session history without regenerating large responses into tool-call JSON.
- Changed model output cap from hardcoded `4096` to configurable `CAL_MAX_OUTPUT_TOKENS`, default `12000`.
- Changed interactive `bash` timeout from 60 seconds to configurable `CAL_BASH_TIMEOUT_MS`, default 5 minutes.
- Added a guard that replaces max-token/no-text final assistant responses with readable fallback text instead of blank PWA replies or orphaned tool calls.
- Added optional generic Codex delegation behind `CODEX_ENABLED=true` and `MULTI_SESSION_ENABLED=true`, including `codex_send`, `codex_check`, configurable `CODEX_DEFAULT_THREAD_ID`, and a dedicated `Codex` Strand for background completion.
- Fixed PWA Strands tab rendering so inactive Strand runtime events render into their own session containers and tab switching opens at the latest messages.
- Added PWA Strands behind `MULTI_SESSION_ENABLED=true`: Cal home plus up to 3 parallel in-memory PWA sessions with independent histories, status tabs, close-summary writeback, stale-session recovery, and local cross-session tools (`inject_context`, `search_session`).
- Added optional Auto Heal Level 1 diagnosis and Level 2 approved-fix surgery with PM2 rollback support.
- Added a provider-neutral Google Workspace MCP example with Drive/Docs search, read, create, and non-destructive batch update tools.
- Added per-server MCP tool allowlist/blocklist policy enforcement and write-confirmation docs for Google Docs writes.
- Increased the PWA single-message input window to 50K characters with a live counter.
- Added multi-channel `ConversationRuntime` with a shared `EventBus` and append-only event log.
- Routed PWA, scheduled jobs, Telegram, and iMessage conversation turns through the runtime boundary.
- Added runtime lifecycle WebSocket events for PWA status/tool/response updates.
- Added `src/test.js` runtime smoke tests covering event ordering, command handling, and HTTP/WebSocket flow.
- Fixed queued PWA steering so guidance is injected before every model call, not only between tool iterations.
- Kept the public package provider-neutral while allowing the optional Auto Heal release surface.

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
