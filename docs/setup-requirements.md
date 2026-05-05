# Setup Requirements

## Required

| Requirement | Purpose |
|-------------|---------|
| Node.js 18+ | Run the gateway |
| Anthropic API key | Model access |

## Optional

| Tool | Purpose |
|------|---------|
| Browser / PWA | Default mobile-friendly Cal surface |
| Tailscale | Optional private mobile access away from the same Wi-Fi network |
| Telegram bot | Mobile chat channel |
| `icalBuddy` | Apple Calendar reads |
| Apple Shortcuts | Calendar and reminder writes |
| `memo` | Apple Notes reads |
| `imsg` | iMessage channel on macOS |
| Brave Search API key | Web/news search |
| QMD | Optional local semantic search |

All optional integrations should be configured through `config/.env`, `config/user.json`, or `config/jobs.json`.
