#!/bin/bash
#
# Setup script gap analysis for the public Cal Gateway distribution.
#
# Usage:
#   ./scripts/verify-setup-scripts.sh [dist-path]

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CAL_DIR="$(dirname "$SCRIPT_DIR")"
DIST_PATH="${1:-$CAL_DIR}"

CONFIG_FILE="$DIST_PATH/config/jobs.json"
if [ ! -f "$CONFIG_FILE" ]; then
  CONFIG_FILE="$DIST_PATH/config/jobs.example.json"
fi

echo -e "${BLUE}"
echo "Cal Gateway setup script check"
echo "=============================="
echo -e "${NC}"
echo -e "${YELLOW}Distribution path:${NC} $DIST_PATH"
echo -e "${YELLOW}Config file:${NC} $CONFIG_FILE"
echo ""

if [ ! -f "$CONFIG_FILE" ]; then
  echo -e "${RED}Config file not found.${NC}"
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo -e "${YELLOW}jq not installed; skipping config-driven checks.${NC}"
  echo "Install jq to enable full setup script verification."
  exit 0
fi

GAPS=()
COVERED=()

check_mapping() {
  local key="$1"
  local script_path="$2"

  if [ -z "$script_path" ]; then
    echo -e "  ${YELLOW}○${NC} $key has no setup script mapping"
    return
  fi

  if [ -f "$DIST_PATH/$script_path" ]; then
    echo -e "  ${GREEN}✓${NC} $key -> $script_path"
    COVERED+=("$key")
  else
    echo -e "  ${RED}✗${NC} $key -> missing $script_path"
    GAPS+=("$key:$script_path")
  fi
}

echo -e "${BOLD}Features:${NC}"
for feature in $(jq -r '.features // {} | keys[]' "$CONFIG_FILE" 2>/dev/null); do
  case "$feature" in
    qmd) check_mapping "features.$feature" "setup/qmd-setup.sh" ;;
    autoHeal) check_mapping "features.$feature" "" ;;
    *) check_mapping "features.$feature" "" ;;
  esac
done

echo ""
echo -e "${BOLD}MCP Servers:${NC}"
for server in $(jq -r '.mcpServers // {} | keys[]' "$CONFIG_FILE" 2>/dev/null); do
  case "$server" in
    qmd) check_mapping "mcpServers.$server" "setup/qmd-setup.sh" ;;
    *) check_mapping "mcpServers.$server" "" ;;
  esac
done

echo ""
echo -e "${BOLD}Existing setup scripts:${NC}"
for script in "$DIST_PATH"/setup/*.sh "$DIST_PATH"/scripts/setup-*.sh; do
  [ -f "$script" ] || continue
  rel_path="${script#$DIST_PATH/}"
  case "$rel_path" in
    setup/qmd-setup.sh) echo -e "  ${GREEN}✓${NC} $rel_path (mapped)" ;;
    *) echo -e "  ${BLUE}○${NC} $rel_path" ;;
  esac
done

echo ""
echo -e "${BOLD}Summary:${NC}"
echo "  Covered mappings: ${#COVERED[@]}"
echo "  Missing scripts:  ${#GAPS[@]}"

if [ "${#GAPS[@]}" -gt 0 ]; then
  echo ""
  echo -e "${RED}Missing setup scripts found.${NC}"
  exit 1
fi

echo -e "${GREEN}Setup script check passed.${NC}"
