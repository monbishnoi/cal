# Cal

**A local-first and privacy-first thinking partner.** Your personal J.A.R.V.I.S. for every day.

Cal is an agent harness: it gives a model memory, tools, a Web UI/PWA, and multi-channel access. It runs on your Mac, remembers context across sessions, connects to the tools you approve, and gives you a browser/PWA assistant by default. Add Telegram or iMessage only if you want messaging-style access too.

*Inspired by "Kal-El", the Superman name, not "HAL" from 2001: A Space Odyssey.*

Cal is what happens when your assistant is not just a chat window, but a local gateway with memory, tools, channels, and routines.

---

## Why CAL?

The major AI clients already have powerful hands: coding tools, browser tools, file tools, connectors, and cloud agents.

What they usually do not give you is a user-owned continuity layer across your life, work, projects, routines, and tools. If they remember, that memory often lives in their cloud, inside their product boundary, under their rules.

CAL's promise is different:

> The model can change. The continuity stays yours.

CAL keeps local memory, session history, handoffs, channels, scheduled routines, and system context in files and folders you control. Use CAL standalone when you have model API access, or bring CAL into other AI clients as an MCP capability layer.

---

## The Superpowers

| Power | What It Does |
|-------|--------------|
| **X-Ray Vision** | See across calendar, mail, notes, files, search, and configured MCP servers |
| **Owned Continuity** | Keep memory, sessions, handoffs, and routines in local state you control |
| **Speed** | Generate morning briefs, end-of-day summaries, handoffs, and recurring routines |
| **Omnipresence** | Use the same Cal from terminal, browser, PWA, Telegram, or iMessage |
| **Strands** | Run up to 3 parallel PWA sessions alongside Cal home for focused work |
| **Tool Use** | Let Claude call local and remote tools through a gateway you control |
| **Auto Heal** | Optionally diagnose local gateway failures and apply approved fixes through a supervised PM2-backed workflow |

---

## What Does That Actually Mean?

### Local-first, privacy-first.

Cal runs locally. Runtime data, memory, sessions, and configuration stay on your machine unless you explicitly connect external services. Claude requests go to Anthropic by default, using your own API key.

### Remembers you.

Not just inside one chat. Cal keeps persistent local context so it can remember your working style, active projects, routines, and handoffs over time.

Daily and periodic jobs can turn scattered activity into useful briefs, summaries, and memory updates. The longer you use Cal, the less you have to repeat.

### Acts for you.

Cal does more than answer. It can read files, search local context, work with notes, inspect schedules, run configured tools, and connect to MCP servers. You talk, Cal routes the work.

### Meets you where you are.

Terminal when you are deep in code. Web browser when you want the richest local UI. Installable PWA when you want Cal on your phone without setting up a messaging bot. Tailscale when you want private access on the go. Telegram and iMessage are optional channels when messaging feels more natural.

Same assistant, same local memory, different doors.

### Lets you work in parallel.

Turn on `MULTI_SESSION_ENABLED=true` to use Strands in the PWA. Cal home stays persistent, and you can open up to 3 temporary parallel Strands for focused tasks. Each Strand has its own conversation history and status, while sharing the same Cal identity, tools, and memory surfaces.

### Resumes active context.

Session Bridge Resume keeps momentum across restarts and handoffs. Cal writes structured active context to `data/last-handoff.json`, keyed by `sessions.home` for the persistent session and by `strand-*` sessionId for PWA Strands.

When a new session starts, it restores its own active task and sees a compact view of what other sessions were doing. V1 write triggers are the 90% Session Bridge handoff, graceful shutdown, and Strand close.

### Yours to configure.

Cal ships with example configuration only. You choose the model, channels, MCP servers, jobs, and local integrations.

---

## Cal Meets You Where You Are

| | **Terminal** | **Web UI / PWA** | **Telegram** | **iMessage** |
|---|:---:|:---:|:---:|:---:|
| **Access** | Desktop | Browser, mobile, tablet | Mobile messaging | macOS / Apple devices |
| **Best For** | Deep work, coding, debugging | Rich text, richer UI, default mobile access | Quick chat on the go | Native Apple messaging |
| **Setup** | Built in | Built in locally; Tailscale optional for remote access | Bot token + allowed chat ID | macOS permissions + local setup |

All channels share the same gateway and local state. Start in terminal, continue in the PWA from your phone, then use Telegram or iMessage only if you want those channels.

---

## What Cal Can Do

Just talk to Cal:

| Capability | What It Does |
|------------|--------------|
| **Conversation** | Chat naturally with Claude while Cal preserves session context |
| **PWA Strands** | Run parallel PWA sessions for separate tasks without blocking Cal home |
| **Calendar** | Read schedules and create events when configured |
| **Mail** | Read and search mail through local setup scripts |
| **Notes** | Read, write, and process notes |
| **Web UI / PWA** | Use Cal in a richer browser interface and install it on mobile |
| **Telegram** | Use Cal privately through your own Telegram bot |
| **iMessage** | Use Cal through local macOS messaging tools |
| **Scheduled Jobs** | Run morning briefs, end-of-day summaries, handoffs, and memory consolidation |
| **Auto Heal** | Disabled-by-default diagnosis and supervised repair for recurring gateway failures |
| **Web Search** | Search the web when an API key is configured |
| **File Operations** | Read, write, edit files, and save prior assistant responses from session history without regenerating long text |
| **MCP Servers** | Connect approved Model Context Protocol servers, including optional external-service examples such as Google Workspace |
| **Codex Delegation** | Optionally delegate coding tasks to Codex in a dedicated PWA Strand |

All of this happens through conversation and explicit configuration.

### Runtime Limits

| Variable | Default | Purpose |
|----------|---------|---------|
| `CAL_MAX_OUTPUT_TOKENS` | `12000` | Maximum model output tokens per Claude API turn. This includes structured tool-use output, not only visible text. |
| `CAL_BASH_TIMEOUT_MS` | `300000` | Timeout for the interactive `bash` tool. Apple app tools keep shorter app-specific timeouts to avoid daemon hangs. |

For "save that previous response" workflows, Cal can use `save_last_assistant_response` to copy the prior answer from local session history instead of regenerating the full text inside a tool call.

---

## What's Working in the Background

| Capability | What It Does |
|------------|--------------|
| **Session Bridge** | Preserves context as conversations grow, so long sessions stay usable |
| **Session Store** | Keeps conversation state locally across channels |
| **Persistent Memory** | Maintains local memory files that can be consolidated over time |
| **Skills** | Adds reusable behavior for briefs, notes, search, mail, meetings, and handoffs |
| **MCP Client** | Connects enabled MCP servers at startup and makes their tools available |
| **Scheduler** | Runs configured jobs on recurring schedules |

You configure the parts you want. The rest can stay off.

Optional MCP examples include [Google Workspace MCP](docs/google-workspace-mcp.md), which exposes a narrow Drive/Docs surface with write confirmation.

### Optional Codex Delegation

Set `CODEX_ENABLED=true` and `MULTI_SESSION_ENABLED=true` to expose `codex_send` and `codex_check`. `codex_send` returns immediately, runs Codex in the background through `@openai/codex-sdk`, and routes completion into a dedicated `Codex` Strand instead of interrupting Cal home.

To keep all delegations in one visible Codex Desktop thread, set:

```bash
CODEX_DEFAULT_THREAD_ID="<codex-thread-id>"
```

If no thread ID is provided, Cal starts a new Codex thread. If a configured or explicit thread cannot be resumed, Cal falls back to a new thread and stores the resulting ID in the Strand metadata.

---

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/monbishnoi/cal.git
cd cal

# 2. Install dependencies
npm install

# 3. Create local config files
cp config/.env.template config/.env
cp config/user.example.json config/user.json
cp config/jobs.example.json config/jobs.json

# 4. Add your API key and review optional jobs
# Edit config/.env:
# CAL_API_KEY=your_api_key_here

# 5. Start Cal
npm start
```

Check status:

```bash
node src/gateway.js status
```

You can also run the bootstrap script:

```bash
./setup/bootstrap.sh
```

Print browser, same-Wi-Fi, and Tailscale PWA URLs:

```bash
./setup/setup-pwa.sh
```

Set up optional private on-the-go PWA access:

```bash
./setup/setup-pwa.sh --tailscale
```

---

## How It Works

```text
+------------------------------------------------------------------------------+
|                              Your Machine                                    |
|                                                                              |
|  +------------------------------------------------------------------------+  |
|  |                           Cal Gateway                                  |  |
|  |                                                                        |  |
|  |   Terminal      Web UI / PWA      Telegram      iMessage               |  |
|  |      |              |               |             |                    |  |
|  |      +--------------+---------------+-------------+                    |  |
|  |                           |                                            |  |
|  |                  Shared Session + Local Memory                         |  |
|  |                           |                                            |  |
|  |       Calendar | Mail | Notes | Files | Search | Bash | MCP Servers    |  |
|  +------------------------------------------------------------------------+  |
|                                  |                                           |
+----------------------------------+-------------------------------------------+
                                   |
                                   v
                              Anthropic API
```

---

## Requirements

| Requirement | How to Get It |
|-------------|---------------|
| macOS | Required |
| Node.js 18+ | `brew install node` or install from nodejs.org |
| API key | Cal is optimized for Anthropic Claude (Opus). Get access via Anthropic direct API, or through model providers like AWS Bedrock, Google Vertex, or enterprise proxies. For other models, use LiteLLM as a local proxy. |
| Claude Code | Optional, for terminal channel. Install from Anthropic. |
| Telegram bot | Optional, created with BotFather |
| Brave Search API key | Optional, for web/news search |

### Model Provider

Cal currently works with the Anthropic API. Compatible endpoint options:

- **Anthropic direct** — default, requires an Anthropic API key
- **AWS Bedrock** — set `CAL_BASE_URL` to your Bedrock endpoint
- **Google Vertex** — set `CAL_BASE_URL` to your Vertex endpoint
- **Other proxies** — any endpoint that speaks the Anthropic Messages API

For users with non-Anthropic API access (OpenAI, Gemini, local models), [LiteLLM](https://github.com/BerriAI/litellm) can be used as a local proxy that translates between formats. Native multi-provider support is planned for the future.

---

## Channels

### Terminal (Full Power)

For full utility, run Cal through Claude Code in the terminal. This gives you the complete Claude Code experience — file editing, bash execution, MCP servers, and all built-in tools — with Cal's memory, context, and personality loaded on top.

Requires [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed separately.

### Web / PWA (Default)

Cal includes a browser UI and installable PWA by default. It is the easiest mobile path because it does not require a bot, phone number, or external messaging account.

```bash
CAL_HTTP_HOST=0.0.0.0
CAL_HTTP_PORT=8080
```

Open `http://localhost:<port>` on the machine running Cal. The default port is `8080`, and you can change it with `CAL_HTTP_PORT`. From another device on the same Wi-Fi, use that machine's local IP address. For private access away from home, use Tailscale and open Cal through your tailnet IP or MagicDNS name.

The Web UI/PWA is the best channel for richer text, structured responses, and future UI features.

### Telegram (Optional)

Telegram is optional and private by default.

1. Create a bot with BotFather.
2. Put the token in `config/.env` as `TELEGRAM_BOT_TOKEN`.
3. Put your allowed chat ID in `config/user.json` as `telegram.chatId`.
4. Set `telegram.enabled` to `true`.

Cal rejects messages from any chat ID other than the configured one.

### iMessage (Optional)

iMessage support is optional and macOS-specific.

```bash
./setup/setup-imessage.sh
```

You may need local messaging tools and Full Disk Access permissions, depending on your setup.

---

## MCP Servers

Cal can connect to external MCP servers at startup and expose their tools to Claude sessions.

Copy `config/jobs.example.json` to `config/jobs.json`, then add enabled servers under `mcpServers`. Runtime config can be split by profile with `config/jobs.<profile>.json` and `CAL_PROFILE=<profile>`. Public distribution includes no private endpoints, vendor credentials, or organization-specific MCP settings.

---

## Configuration

Public distribution ships only examples:

| File | Purpose |
|------|---------|
| `config/.env.template` | Environment variable template |
| `config/user.example.json` | User profile and channel settings template |
| `config/jobs.example.json` | Runtime jobs, features, and MCP server configuration template |
| `config/imessage.example.json` | iMessage configuration example, when present |

Do not commit real `config/.env`, `config/user.json`, runtime data, OAuth tokens, memory logs, or session files.

---

## Privacy

- **Local-first:** Cal runs on your machine and stores runtime data locally.
- **Your keys:** API keys live in your local config files.
- **No bundled secrets:** Public distribution ships templates, not credentials.
- **No telemetry:** Cal does not include product analytics or phone-home behavior.
- **Explicit integrations:** External services are used only when you configure them.

Runtime data is stored under folders such as `data/`, `memory/`, and `context/`. Treat those as private local state.

---

## Learn More

- [Docs](docs/) - Public distribution notes and security guidance
- [PWA Setup](docs/pwa-setup.md) - Browser, mobile, and Tailscale access
- [Security](docs/security.md) - What should and should not be committed
- [Shortcuts](shortcuts/) - Optional Apple Shortcuts for events and reminders
- [Setup](setup/) - Optional setup scripts and integration notes

---

## License

MIT
