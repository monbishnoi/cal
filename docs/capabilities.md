# Capabilities

Cal combines conversation, local tools, scheduled jobs, reusable skills, and user-owned continuity.

| Capability | Default | Notes |
|------------|---------|-------|
| Conversation | On | Uses your configured model and local session store |
| Persistent memory | Local | Example files ship; real memory is ignored |
| Telegram | Off | Requires bot token and allowed chat ID |
| iMessage | Off | macOS-only and skipped elsewhere |
| Web/PWA | On | Default rich browser UI and installable mobile surface |
| Scheduled jobs | Off | Enabled per job in `config/jobs.json` |
| MCP servers | Off | Generic, profile-aware, and explicitly enabled |
| QMD search | Off | Optional local semantic search setup |
| Codex delegation | Off | Optional `@openai/codex-sdk` bridge; requires `CODEX_ENABLED=true` and `MULTI_SESSION_ENABLED=true` |
| Auto Heal review | Off | Proposal-only repair review in the public template |

## Codex Delegation

When enabled, Cal registers `codex_send` and `codex_check`. `codex_send` starts background Codex work and writes progress/results to a dedicated `Codex` Strand. Set `CODEX_DEFAULT_THREAD_ID` if you want Cal to reuse one visible Codex Desktop thread by default; otherwise each delegation can start a new thread or use an explicit `threadId`.

## Auto Heal Review

The public template includes a disabled `autoHeal` feature and an `auto-heal-review` job. It is designed to inspect local logs and write a repair proposal, not apply changes automatically.

Keep it disabled until you have reviewed the prompt, output path, and file permissions for your own setup.

## Web UI / PWA

The Web UI is the default non-terminal channel. It works locally in a browser, can be installed on mobile as a PWA, and can be reached privately through Tailscale when your devices share a tailnet.

## Steward Fit

| Steward Role | Capabilities |
|--------------|--------------|
| Gateway | Web/PWA, terminal, Telegram, iMessage, skills |
| Custodian | Persistent memory, session store, handoffs |
| Witness | Daily logs, scheduled reviews, consolidation |
| Advocate | Morning brief, EOD brief, Auto Heal proposals |
| Membrane | Explicit config, optional channels, MCP filtering |
| Evolver | Skills, memory maintenance, repair proposals |
