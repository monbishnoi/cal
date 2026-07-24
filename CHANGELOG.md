# Changelog

## v2.1.0 - 2026-07-23

- Added a closed-loop workflow for Cal-initiated Codex tasks that detects blocking questions from the full Codex response.
- Added a blue `attention` Strand state with Codex questions, Cal's proposed answer, and approval or replacement replies in one timeline.
- Added same-thread Codex resume after approval so task context and execution history remain intact.
- Added `/ask-me` and confirmation-gated `/dont-ask-me` policies, with a three-cycle autonomous safety cap.
- Added provider-neutral attention notifications through the Gateway's configured notification channel.
- Added focused loop tests and preserved existing text, voice, image, Strand, scheduler, and Session Bridge behavior.

## v2.0.0 - 2026-07-17

- Added optional Talkbox voice mode to the PWA through environment-configured `/voice/*` proxy routes.
- Added active Home/Strand voice-session binding, four-layer context hydration, progress narration events, and idempotent transcript writeback.
- Added a shared response coordinator that prevents duplicate Realtime responses and recovers cleanly from data-channel failures.
- Added voice lifecycle benchmarks, WebRTC diagnostics, microphone visualization, and reconnect/retry behavior.
- Added conversation-context generation with an earlier-summary layer plus a verbatim recent-message tail.
- Added semantic nightly startup-memory refresh with deterministic strength decay and a bounded `STARTUP-MEMORY.md` projection.
- Upgraded `@openai/codex-sdk` to `0.144.4`.
- Preserved text-only, image-upload, WebSocket, scheduled-job, and Session Bridge behavior.

## v1.0.3 - 2026-06-24

- Added Session Bridge Resume: `last-handoff.json` now supports structured, strand-aware active context with `sessions.home` and Strand entries keyed by sessionId.
- Restores each session's own active context while summarizing other active or closed sessions.
- Writes active context during 90% Session Bridge handoff, graceful shutdown, and Strand close.
- Preserves compatibility with the previous summary-only handoff file shape.

## Unreleased

- Added `save_last_assistant_response` so save/export requests can copy prior assistant text from session history without regenerating large responses into tool-call JSON.
- Changed model output cap from hardcoded `4096` to configurable `CAL_MAX_OUTPUT_TOKENS`, default `12000`.
- Changed interactive `bash` timeout from 60 seconds to configurable `CAL_BASH_TIMEOUT_MS`, default 5 minutes.
- Added a guard that replaces max-token/no-text final assistant responses with readable fallback text instead of blank PWA replies or orphaned tool calls.
- Added optional generic Codex delegation behind `CODEX_ENABLED=true` and `MULTI_SESSION_ENABLED=true`, including `codex_send`, `codex_check`, configurable `CODEX_DEFAULT_THREAD_ID`, and a dedicated `Codex` Strand for background completion.
- Fixed PWA Strands tab rendering so inactive Strand runtime events render into their own session containers and tab switching opens at the latest messages.
- Added PWA Strands behind `MULTI_SESSION_ENABLED=true`: Cal home plus up to 3 parallel in-memory PWA sessions with independent histories, status tabs, close-summary writeback, stale-session recovery, and local cross-session tools (`inject_context`, `search_session`).
- Added a provider-neutral Google Workspace MCP example with Drive/Docs search, read, create, and non-destructive batch update tools.
- Added per-server MCP tool allowlist/blocklist policy enforcement and write-confirmation docs for Google Docs writes.
- Increased the PWA single-message input window to 50K characters with a live counter.
- Added multi-channel `ConversationRuntime` with a shared `EventBus` and append-only event log.
- Routed PWA, scheduled jobs, Telegram, and iMessage conversation turns through the runtime boundary.
- Added runtime lifecycle WebSocket events for PWA status/tool/response updates.
- Added `src/test.js` runtime smoke tests covering event ordering, command handling, and HTTP/WebSocket flow.
- Fixed queued PWA steering so guidance is injected before every model call, not only between tool iterations.

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
