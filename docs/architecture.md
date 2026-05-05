# Architecture

Cal Gateway is a local daemon that coordinates channels, sessions, skills, jobs, and tools.

At the product level, CAL is an instance of the System Steward pattern: a program that maintains a coherent model of a system and helps preserve its health over time. In the public release, the first system is a person's own work/life context.

```text
+------------------------------------------------------------------+
|                        Your Machine                              |
|                                                                  |
|  +------------------------------------------------------------+  |
|  |                       Cal Gateway                          |  |
|  |                                                            |  |
|  |  Terminal   Web UI / PWA   Telegram   iMessage             |  |
|  |      |            |           |          |                  |  |
|  |      +------------+-----------+----------+                  |  |
|  |                         |                                  |  |
|  |                Shared Session Store                         |  |
|  |                         |                                  |  |
|  |  Skills | Scheduler | Tools | MCP Client | Memory          |  |
|  +------------------------------------------------------------+  |
|                         |                                        |
|                  Local runtime data                             |
+-------------------------+----------------------------------------+
                          |
                          v
                    Anthropic API
```

## Runtime Config

Public releases ship examples only:

- `config/.env.template`
- `config/user.example.json`
- `config/jobs.example.json`
- `config/imessage.example.json`

Runtime files such as `config/.env`, `config/user.json`, and `config/jobs.json` are ignored.

Profile overlays can be added as `config/jobs.<profile>.json` and selected with `CAL_PROFILE=<profile>`.

## Stewarding Layers

| Layer | Purpose | Files |
|-------|---------|-------|
| Access | Meet the user across surfaces | `src/http-server.js`, `src/telegram.js`, `src/imessage.js` |
| Continuity | Preserve conversation and handoffs | `src/session.js`, `src/session-store.js`, `src/session-bridge.js` |
| Memory | Keep useful state user-owned | `context/`, `memory/`, `src/context.js` |
| Action | Observe and influence the system | `src/tools.js`, `src/mcp-client.js`, `src/mcp-server.js` |
| Routine | Maintain cadence over time | `src/scheduler.js`, `config/jobs.example.json` |
| Evolution | Improve behavior and repair proposals | `skills/`, Auto Heal review job |

## MCP Servers

MCP servers are disabled unless explicitly enabled in runtime config. Each server can also declare `profile`, `profiles`, `public`, or `distribution` metadata so the public build only connects to the intended local configuration.

## Data Storage

| Path | Purpose | Shipped |
|------|---------|---------|
| `data/` | Sessions and runtime state | `.gitkeep` only |
| `memory/` | Daily logs and generated briefs | `.gitkeep` only |
| `context/` | User profile and long-term memory | examples only |
| `logs/` | Gateway logs | `.gitkeep` only |
