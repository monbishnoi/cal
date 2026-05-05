#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CAL_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$CAL_DIR/config/.env"
PORT="${CAL_HTTP_PORT:-8080}"
HOST="${CAL_HTTP_HOST:-0.0.0.0}"
ENABLE_TAILSCALE=false

for arg in "$@"; do
  case "$arg" in
    --tailscale) ENABLE_TAILSCALE=true ;;
    --help|-h)
      echo "Usage: ./setup/setup-pwa.sh [--tailscale]"
      echo ""
      echo "Configures and verifies Web UI / PWA access."
      echo "Use --tailscale to install/start Tailscale when possible."
      exit 0
      ;;
    *)
      echo "Unknown option: $arg"
      echo "Usage: ./setup/setup-pwa.sh [--tailscale]"
      exit 1
      ;;
  esac
done

load_env_file() {
  if [ ! -f "$ENV_FILE" ]; then
    return
  fi

  while IFS= read -r raw_line || [ -n "$raw_line" ]; do
    line="$(echo "$raw_line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [ -z "$line" ] && continue
    [[ "$line" == \#* ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    key="$(echo "$key" | sed 's/[[:space:]]//g')"
    value="$(echo "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    value="${value%\"}"
    value="${value#\"}"
    value="${value%\'}"
    value="${value#\'}"

    case "$key" in
      CAL_HTTP_PORT) PORT="${CAL_HTTP_PORT:-$value}" ;;
      CAL_HTTP_HOST) HOST="${CAL_HTTP_HOST:-$value}" ;;
    esac
  done < "$ENV_FILE"
}

ensure_env_file() {
  mkdir -p "$CAL_DIR/config"

  if [ ! -f "$ENV_FILE" ]; then
    cp "$CAL_DIR/config/.env.template" "$ENV_FILE"
    echo "Created config/.env"
  fi
}

ensure_http_config() {
  if grep -q '^CAL_HTTP_PORT=' "$ENV_FILE"; then
    sed -i.bak "s/^CAL_HTTP_PORT=.*/CAL_HTTP_PORT=${PORT}/" "$ENV_FILE"
  else
    printf '\nCAL_HTTP_PORT=%s\n' "$PORT" >> "$ENV_FILE"
  fi

  if grep -q '^CAL_HTTP_HOST=' "$ENV_FILE"; then
    sed -i.bak "s/^CAL_HTTP_HOST=.*/CAL_HTTP_HOST=${HOST}/" "$ENV_FILE"
  else
    printf 'CAL_HTTP_HOST=%s\n' "$HOST" >> "$ENV_FILE"
  fi

  rm -f "$ENV_FILE.bak"
}

detect_wifi_ip() {
  if command -v ipconfig >/dev/null 2>&1; then
    ipconfig getifaddr en0 2>/dev/null || true
  elif command -v hostname >/dev/null 2>&1; then
    hostname -I 2>/dev/null | awk '{print $1}' || true
  else
    true
  fi
}

gateway_is_running() {
  curl -fsS "http://localhost:${PORT}/health" >/dev/null 2>&1
}

ensure_tailscale() {
  if command -v tailscale >/dev/null 2>&1; then
    return
  fi

  if [ "$ENABLE_TAILSCALE" != true ]; then
    return
  fi

  if [[ "$(uname -s)" == "Darwin" ]] && command -v brew >/dev/null 2>&1; then
    echo "Installing Tailscale with Homebrew..."
    brew install tailscale
  else
    echo "Tailscale is not installed."
    echo "Install it from https://tailscale.com/download, then rerun this script."
  fi
}

start_tailscale_if_requested() {
  if [ "$ENABLE_TAILSCALE" != true ] || ! command -v tailscale >/dev/null 2>&1; then
    return
  fi

  if tailscale ip -4 >/dev/null 2>&1; then
    return
  fi

  echo "Starting Tailscale login..."
  tailscale up || true
}

tailscale_ip() {
  if command -v tailscale >/dev/null 2>&1; then
    tailscale ip -4 2>/dev/null | grep -E '^[0-9]+(\.[0-9]+){3}$' | head -1 || true
  fi
}

echo ""
echo "Cal Web UI / PWA setup"
echo "======================"
echo ""

ensure_env_file
load_env_file
ensure_http_config
ensure_tailscale
start_tailscale_if_requested

echo "Configured:"
echo "  CAL_HTTP_HOST=${HOST}"
echo "  CAL_HTTP_PORT=${PORT}"
echo ""

if gateway_is_running; then
  echo "Gateway status: running"
else
  echo "Gateway status: not running yet"
  echo "Start it with: npm start"
fi
echo ""

echo "Local URL:"
echo "  http://localhost:${PORT}"
echo ""

WIFI_IP="$(detect_wifi_ip)"
if [ -n "$WIFI_IP" ] && [ "$HOST" != "127.0.0.1" ]; then
  echo "Same-Wi-Fi URL:"
  echo "  http://${WIFI_IP}:${PORT}"
  echo ""
elif [ "$HOST" = "127.0.0.1" ]; then
  echo "Same-Wi-Fi URL disabled because CAL_HTTP_HOST=127.0.0.1."
  echo "Set CAL_HTTP_HOST=0.0.0.0 to allow same-Wi-Fi and Tailscale access."
  echo ""
fi

TAILSCALE_IP="$(tailscale_ip)"
if [ -n "$TAILSCALE_IP" ]; then
  echo "Tailscale URL:"
  echo "  http://${TAILSCALE_IP}:${PORT}"
  echo ""
elif command -v tailscale >/dev/null 2>&1; then
  echo "Tailscale is installed, but no active tailnet IP was found."
  echo "Open Tailscale or run: tailscale up"
  echo ""
else
  echo "Optional on-the-go PWA:"
  echo "  Run ./setup/setup-pwa.sh --tailscale to install/start Tailscale where supported."
  echo ""
fi

echo "Install as PWA:"
echo "  iOS Safari: Share -> Add to Home Screen"
echo "  Android Chrome: Menu -> Install app or Add to Home Screen"
echo ""
