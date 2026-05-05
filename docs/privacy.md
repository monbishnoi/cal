# Privacy

Cal is local-first. Runtime state stays on your machine unless you explicitly configure external services.

That matters because CAL's core asset is continuity: memory, handoffs, routines, and context. Those should be owned by the user, not trapped inside one vendor's cloud or one AI client's product boundary.

## What Ships

The public distribution ships templates, source code, setup scripts, shortcuts, and public skills.

It should not ship live credentials, personal memory, sessions, local logs, OAuth token folders, or machine-specific paths.

## External Services

Cal talks to Anthropic by default when you provide an API key. Optional services such as Telegram, Brave Search, and MCP servers are used only when configured.

## Safe Defaults

- Optional channels are disabled by default.
- The Web UI/PWA is available locally by default; use Tailscale for private remote access instead of exposing it publicly.
- Scheduled jobs are disabled by default.
- MCP servers are disabled by default.
- iMessage skips outside macOS or when the local messaging tool is unavailable.
- Auto Heal review is disabled by default and proposal-only in the public template.
