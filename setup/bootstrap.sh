#!/bin/bash

set -e

echo ""
echo "Cal Gateway public setup"
echo "========================"
echo ""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CAL_DIR="$(dirname "$SCRIPT_DIR")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18+ is required."
  echo "Install Node.js, then rerun this script."
  exit 1
fi

NODE_MAJOR="$(node -v | sed 's/v//' | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node.js 18+ is required. Found: $(node -v)"
  exit 1
fi

cd "$CAL_DIR"

mkdir -p config data memory context logs

if [ ! -f config/.env ]; then
  cp config/.env.template config/.env
  echo "Created config/.env"
fi

if [ ! -f config/user.json ]; then
  cp config/user.example.json config/user.json
  echo "Created config/user.json"
fi

if [ ! -f config/jobs.json ]; then
  cp config/jobs.example.json config/jobs.json
  echo "Created config/jobs.json"
fi

if [ ! -f context/USER.md ]; then
  cp context/USER.example.md context/USER.md
  echo "Created context/USER.md"
fi

if [ ! -f context/MEMORY.md ]; then
  cp context/MEMORY.example.md context/MEMORY.md
  echo "Created context/MEMORY.md"
fi

npm install

./setup/setup-pwa.sh

echo ""
echo "Next steps:"
echo "1. Edit config/.env and set CAL_API_KEY."
echo "2. Edit config/user.json for your name, timezone, and optional channels."
echo "3. Run ./setup/setup-pwa.sh --tailscale if you want private on-the-go PWA access."
echo "4. Edit config/jobs.json if you want scheduled jobs or MCP servers."
echo "5. Run: npm start"
