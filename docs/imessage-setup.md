# iMessage Setup

iMessage is optional and macOS-only.

## Requirements

- macOS
- `imsg`
- Full Disk Access for the local messaging tool and Node.js
- A configured iMessage sender and chat ID

## Setup Script

```bash
./setup/setup-imessage.sh
```

The script helps discover the local chat ID and writes ignored local config.

## Manual Config

Copy the example:

```bash
cp config/imessage.example.json config/imessage.json
```

Or configure the `imessage` block in `config/user.json`.

## Graceful Skip

On non-macOS systems, or when `imsg` is unavailable, Cal logs the reason and continues without iMessage.

