# Getting Started

Get Cal running locally with example config. The browser UI and PWA are available by default; messaging channels are optional.

## Prerequisites

- Node.js 18 or newer
- An Anthropic API key
- macOS for Apple Calendar, Apple Notes, Apple Mail, and iMessage integrations
- A Telegram bot token if you want Telegram
- Optional local tools such as `icalBuddy`, `memo`, `imsg`, and QMD

## Quick Start

```bash
npm install
cp config/.env.template config/.env
cp config/user.example.json config/user.json
cp config/jobs.example.json config/jobs.json
```

Edit `config/.env` and set:

```bash
CAL_API_KEY=your_api_key_here
```

Then start Cal:

```bash
npm start
```

Open the Web UI:

```text
http://localhost:<port>
```

The default port is `8080`; change it with `CAL_HTTP_PORT`. On mobile, open the same URL from the same Wi-Fi network using your computer's local IP address, or use Tailscale for private access through your tailnet.

You can also run:

```bash
./setup/bootstrap.sh
```

To print browser, same-Wi-Fi, and Tailscale PWA URLs:

```bash
./setup/setup-pwa.sh
```

For optional on-the-go access, run:

```bash
./setup/setup-pwa.sh --tailscale
```

## Default Web / PWA Access

The Web UI is Cal's easiest mobile experience because it does not require Telegram, iMessage, or another external channel. It is also the best place for richer text, structured output, and future UI features.

For private access away from the same network, install Tailscale on your Cal machine and phone, then open the gateway through the machine's tailnet IP or MagicDNS name.

## Optional Messaging Channels

Telegram is configured through `TELEGRAM_BOT_TOKEN`, `telegram.enabled`, and `telegram.chatId`.

iMessage is macOS-only. Run `./setup/setup-imessage.sh` after installing the required local messaging tool and granting local permissions.

## Optional Jobs And MCP Servers

Scheduled jobs, feature flags, and MCP servers live in `config/jobs.json`. Public releases ship `config/jobs.example.json`; your runtime file is ignored by Git.

Use `CAL_PROFILE=<profile>` with `config/jobs.<profile>.json` when you want a separate local overlay.

## Verification

```bash
npm run audit:public
node --check src/gateway.js
```

If optional local tools are not installed, Cal should skip those features instead of failing startup.
