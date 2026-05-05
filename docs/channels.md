# Channels

Cal uses one shared local session across every enabled channel.

| Channel | Status | Best For | Setup |
|---------|--------|----------|-------|
| Terminal | Built in | Deep work and local tool use | `npm start` |
| Web UI / PWA | Built in | Rich text, richer UI, browser and mobile access | Local by default; Tailscale optional |
| Telegram | Optional | Private mobile messaging | Bot token and allowed chat ID |
| iMessage | Optional, macOS-only | Apple Messages workflows | Local messaging tool and permissions |

## Web UI / PWA

The browser UI is the default non-terminal experience. It gives Cal room for richer text, structured responses, and UI features that are awkward inside a chat bubble.

Open Cal locally:

```text
http://localhost:<port>
```

The default port is `8080`; change it with `CAL_HTTP_PORT`. For another device on the same Wi-Fi, use the host machine's local IP address. For private access while away from that network, install Tailscale on both devices and open Cal through the machine's tailnet IP or MagicDNS name.

On mobile, add the page to your home screen to use it as a PWA.

## Telegram

Telegram is private by configuration: Cal rejects chats that do not match `telegram.chatId`.

Set `TELEGRAM_BOT_TOKEN` in `config/.env`, then set `telegram.enabled` and `telegram.chatId` in `config/user.json`.

## iMessage

iMessage support is optional and skipped automatically outside macOS.

Use `config/imessage.example.json` or the `imessage` section in `config/user.json`. The setup script helps discover the local chat ID and writes local, ignored config.

Messaging channels are optional. Use Telegram when you want bot-style chat instead of the richer PWA surface.
