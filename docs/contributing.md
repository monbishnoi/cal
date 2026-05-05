# Contributing

Thanks for helping make Cal easier to run locally.

## Public Distribution Rules

- Do not commit real credentials, runtime config, sessions, memory, logs, or OAuth tokens.
- Keep integrations generic and optional.
- Prefer environment variables or example config for service-specific setup.
- Keep platform-specific features graceful when dependencies are missing.
- Run `npm run audit:public` before publishing.

## Good Public Additions

- Generic MCP server support
- Optional channel setup
- Documentation that helps users configure their own local environment
- Tests or audits that prevent private data from entering the repo

