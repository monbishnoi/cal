# Security And Privacy

Cal Gateway is local-first, but it can access sensitive local data when you enable tools.

Before publishing or deploying:

- Keep `config/.env` out of Git.
- Keep `config/user.json` out of Git.
- Keep `config/jobs.json` and `config/jobs.<profile>.json` out of Git unless they are intentionally sanitized examples.
- Keep `data/`, `memory/`, `logs/`, and OAuth token folders out of Git.
- Use `telegram.chatId` to restrict the Telegram bot to one allowed chat.
- Review enabled MCP servers before startup.
- Avoid configuring MCP servers with credentials in `config/jobs.json`; prefer environment variables.

The public distribution should only include examples and generic setup instructions.
