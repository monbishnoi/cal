#!/bin/bash
#
# QMD Setup Script for Cal Gateway
#
# This script automates QMD installation and configuration for users
# who want semantic search capabilities.
#
# Features:
#   - Auto-detects common folders to index
#   - Interactive prompts to customize collections
#   - Sets up launchd daemon for persistent MCP server
#
# Usage: ./qmd-setup.sh [--cal-dir /path/to/cal] [--port 8181]

set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Get script directory and Cal root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$SCRIPT_DIR" == */setup ]]; then
    CAL_DIR="$(dirname "$SCRIPT_DIR")"
else
    CAL_DIR="$SCRIPT_DIR"
fi

QMD_PORT="${QMD_PORT:-8181}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --cal-dir)
            if [ -z "${2:-}" ]; then
                echo -e "${RED}Missing value for --cal-dir${NC}"
                exit 1
            fi
            CAL_DIR="$2"
            shift 2
            ;;
        --port)
            if [ -z "${2:-}" ]; then
                echo -e "${RED}Missing value for --port${NC}"
                exit 1
            fi
            QMD_PORT="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: ./qmd-setup.sh [--cal-dir /path/to/cal] [--port 8181]"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            echo "Usage: ./qmd-setup.sh [--cal-dir /path/to/cal] [--port 8181]"
            exit 1
            ;;
    esac
done

if ! [[ "$QMD_PORT" =~ ^[0-9]+$ ]] || [ "$QMD_PORT" -lt 1 ] || [ "$QMD_PORT" -gt 65535 ]; then
    echo -e "${RED}Invalid --port value: $QMD_PORT${NC}"
    exit 1
fi

port_in_use() {
    local port="$1"
    if command -v lsof >/dev/null 2>&1; then
        lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
    elif command -v nc >/dev/null 2>&1; then
        nc -z localhost "$port" >/dev/null 2>&1
    else
        return 1
    fi
}

select_qmd_port() {
    local requested="$1"
    local port="$requested"
    local max_port=$((requested + 50))

    while [ "$port" -le "$max_port" ]; do
        if ! port_in_use "$port"; then
            echo "$port"
            return 0
        fi
        port=$((port + 1))
    done

    echo -e "${RED}No available QMD port found in range ${requested}-${max_port}.${NC}" >&2
    exit 1
}

update_jobs_config() {
    local endpoint="$1"
    local collections_json="$2"
    local jobs_path="$CAL_DIR/config/jobs.json"
    local example_path="$CAL_DIR/config/jobs.example.json"

    mkdir -p "$CAL_DIR/config"

    if [ ! -f "$jobs_path" ]; then
        if [ -f "$example_path" ]; then
            cp "$example_path" "$jobs_path"
            echo -e "  ${GREEN}✓${NC} Created config/jobs.json from example"
        else
            echo '{"jobs":[],"settings":{},"features":{},"mcpServers":{}}' > "$jobs_path"
            echo -e "  ${GREEN}✓${NC} Created config/jobs.json"
        fi
    fi

    QMD_ENDPOINT="$endpoint" QMD_COLLECTIONS="$collections_json" JOBS_PATH="$jobs_path" node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'fs';

const path = process.env.JOBS_PATH;
const endpoint = process.env.QMD_ENDPOINT;
const collections = JSON.parse(process.env.QMD_COLLECTIONS || '[]');
const config = JSON.parse(readFileSync(path, 'utf8'));

config.jobs = Array.isArray(config.jobs) ? config.jobs : [];
config.settings = config.settings || {};
config.features = config.features || {};
config.mcpServers = config.mcpServers || {};

config.features.qmd = {
  ...(config.features.qmd || {}),
  enabled: true,
  httpEndpoint: endpoint,
  collections,
  _comment: 'Enabled by setup/qmd-setup.sh. Disable by setting enabled to false.',
};

config.mcpServers.qmd = {
  ...(config.mcpServers.qmd || {}),
  endpoint,
  enabled: true,
  description: 'Local semantic search MCP server.',
};

writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
NODE

    echo -e "  ${GREEN}✓${NC} Enabled QMD in config/jobs.json"
}

echo -e "${BLUE}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║            Cal Gateway — QMD Setup Wizard                    ║"
echo "║              Semantic Search Configuration                    ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Check if Cal directory exists
if [ ! -d "$CAL_DIR" ]; then
    echo -e "${RED}Error: Cal directory not found: $CAL_DIR${NC}"
    echo "Usage: ./qmd-setup.sh [--cal-dir /path/to/cal] [--port 8181]"
    exit 1
fi

echo -e "${YELLOW}Cal directory:${NC} $CAL_DIR"
echo ""

PLIST_FILE="$HOME/Library/LaunchAgents/ai.qmd.daemon.plist"
if [ -f "$PLIST_FILE" ]; then
    launchctl unload "$PLIST_FILE" 2>/dev/null || true
fi

SELECTED_QMD_PORT="$(select_qmd_port "$QMD_PORT")"
QMD_ENDPOINT="http://localhost:${SELECTED_QMD_PORT}/mcp"
if [ "$SELECTED_QMD_PORT" != "$QMD_PORT" ]; then
    echo -e "${YELLOW}Port ${QMD_PORT} is in use; using ${SELECTED_QMD_PORT} for QMD.${NC}"
fi
echo -e "${YELLOW}QMD endpoint:${NC} $QMD_ENDPOINT"
echo ""

# ─────────────────────────────────────────────────────────────────
# Step 1: Check/Install QMD
# ─────────────────────────────────────────────────────────────────

echo -e "${BOLD}Step 1: Checking QMD installation...${NC}"
echo ""

if command -v qmd &> /dev/null; then
    QMD_VERSION=$(qmd --version 2>/dev/null || echo "unknown")
    echo -e "  ${GREEN}✓${NC} QMD already installed: $QMD_VERSION"
else
    echo -e "  ${YELLOW}→${NC} QMD not found. Installing..."
    npm install -g @tobilu/qmd
    echo -e "  ${GREEN}✓${NC} QMD installed"
fi
echo ""

# ─────────────────────────────────────────────────────────────────
# Step 2: Detect and Configure Collections (Interactive)
# ─────────────────────────────────────────────────────────────────

echo -e "${BOLD}Step 2: Configuring collections to index...${NC}"
echo ""

folder_description() {
    case "$1" in
        context) echo "User profile, long-term memory, core context files" ;;
        memory) echo "Daily logs, episodic memory" ;;
        docs) echo "Documentation, projects, notes" ;;
        skills) echo "Skill definitions and prompts" ;;
        *) echo "User-defined collection" ;;
    esac
}

# Detect which folders exist
DETECTED_FOLDERS=()
DETECTED_DISPLAY=()

for folder in context memory docs skills; do
    if [ -d "$CAL_DIR/$folder" ]; then
        DETECTED_FOLDERS+=("$folder")
        FILE_COUNT=$(find "$CAL_DIR/$folder" -type f -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
        DETECTED_DISPLAY+=("$folder ($FILE_COUNT .md files) — $(folder_description "$folder")")
    fi
done

if [ ${#DETECTED_FOLDERS[@]} -eq 0 ]; then
    echo -e "  ${YELLOW}⚠${NC} No standard folders found (context/, memory/, docs/, skills/)"
    echo ""
    echo "  You'll need to specify folders manually."
else
    echo -e "  ${GREEN}Found these folders to index:${NC}"
    echo ""
    for display in "${DETECTED_DISPLAY[@]}"; do
        echo -e "    ${GREEN}✓${NC} $display"
    done
fi

echo ""

# Ask user to confirm and optionally add more
echo -e "  ${YELLOW}Customize collections?${NC}"
echo ""
echo "  Press Enter to use detected folders, or type folder names to add/remove."
echo "  Examples:"
echo "    - Press Enter to accept defaults"
echo "    - Type 'projects' to add projects/ folder"
echo "    - Type '-docs' to remove docs/ from indexing"
echo ""
read -p "  Additional folders (or Enter to continue): " CUSTOM_INPUT

# Process user input
FINAL_FOLDERS=("${DETECTED_FOLDERS[@]}")

if [ -n "$CUSTOM_INPUT" ]; then
    for item in $CUSTOM_INPUT; do
        if [[ "$item" == -* ]]; then
            # Remove folder (starts with -)
            remove_folder="${item:1}"
            FINAL_FOLDERS=("${FINAL_FOLDERS[@]/$remove_folder}")
        else
            # Add folder
            if [ -d "$CAL_DIR/$item" ]; then
                # Check if not already in list
                if [[ ! " ${FINAL_FOLDERS[*]} " =~ " ${item} " ]]; then
                    FINAL_FOLDERS+=("$item")
                    echo -e "    ${GREEN}+${NC} Added: $item"
                fi
            else
                echo -e "    ${RED}✗${NC} Folder not found: $CAL_DIR/$item (skipping)"
            fi
        fi
    done
fi

# Clean up empty entries
CLEAN_FOLDERS=()
for folder in "${FINAL_FOLDERS[@]}"; do
    if [ -n "$folder" ]; then
        CLEAN_FOLDERS+=("$folder")
    fi
done
FINAL_FOLDERS=("${CLEAN_FOLDERS[@]}")

if [ ${#FINAL_FOLDERS[@]} -eq 0 ]; then
    echo -e "${RED}Error: No folders selected for indexing.${NC}"
    exit 1
fi

echo ""
echo -e "  ${GREEN}Collections to create:${NC} ${FINAL_FOLDERS[*]}"
echo ""

# ─────────────────────────────────────────────────────────────────
# Step 3: Create Collections
# ─────────────────────────────────────────────────────────────────

echo -e "${BOLD}Step 3: Creating QMD collections...${NC}"
echo ""

EXISTING_COLLECTIONS=$(qmd collection list 2>/dev/null || echo "")

for collection in "${FINAL_FOLDERS[@]}"; do
    if echo "$EXISTING_COLLECTIONS" | grep -q "^$collection$"; then
        echo -e "  ${GREEN}✓${NC} Collection '$collection' already exists"
    else
        echo -e "  ${YELLOW}→${NC} Creating collection '$collection'..."
        qmd collection add "$CAL_DIR/$collection" --name "$collection"
        echo -e "  ${GREEN}✓${NC} Collection '$collection' created"
    fi
done
echo ""

# ─────────────────────────────────────────────────────────────────
# Step 4: Add Context Metadata
# ─────────────────────────────────────────────────────────────────

echo -e "${BOLD}Step 4: Adding context metadata...${NC}"
echo ""

for collection in "${FINAL_FOLDERS[@]}"; do
    desc="$(folder_description "$collection")"
    qmd context add "qmd://$collection" --text "$desc" 2>/dev/null || true
    echo -e "  ${GREEN}✓${NC} $collection: $desc"
done
echo ""

# ─────────────────────────────────────────────────────────────────
# Step 5: Initial Indexing
# ─────────────────────────────────────────────────────────────────

echo -e "${BOLD}Step 5: Running initial index update...${NC}"
echo ""

cd "$CAL_DIR"
qmd update
echo -e "  ${GREEN}✓${NC} BM25 indexes created"
echo ""

# ─────────────────────────────────────────────────────────────────
# Step 6: Generate Embeddings
# ─────────────────────────────────────────────────────────────────

echo -e "${BOLD}Step 6: Generating vector embeddings...${NC}"
echo -e "  ${YELLOW}(This may take a few minutes on first run)${NC}"
echo ""

qmd embed
echo -e "  ${GREEN}✓${NC} Vector embeddings generated"
echo ""

# ─────────────────────────────────────────────────────────────────
# Step 7: Set up QMD Daemon
# ─────────────────────────────────────────────────────────────────

echo -e "${BOLD}Step 7: Setting up QMD daemon...${NC}"
echo ""

QMD_PATH=$(which qmd)
LOG_DIR="$CAL_DIR/logs"

# Create logs directory if it doesn't exist
mkdir -p "$(dirname "$PLIST_FILE")"
mkdir -p "$LOG_DIR"

cat > "$PLIST_FILE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.qmd.daemon</string>

    <key>ProgramArguments</key>
    <array>
        <string>$QMD_PATH</string>
        <string>mcp</string>
        <string>--http</string>
        <string>--port</string>
        <string>$SELECTED_QMD_PORT</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$CAL_DIR</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>$LOG_DIR/qmd-daemon.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/qmd-daemon-error.log</string>
</dict>
</plist>
EOF

# Load the daemon
launchctl unload "$PLIST_FILE" 2>/dev/null || true
launchctl load "$PLIST_FILE"

echo -e "  ${GREEN}✓${NC} QMD daemon configured"
echo ""

# Verify daemon is running
sleep 2
if curl -s "$QMD_ENDPOINT" &> /dev/null; then
    echo -e "  ${GREEN}✓${NC} QMD HTTP server responding on $QMD_ENDPOINT"
else
    echo -e "  ${YELLOW}⚠${NC} QMD daemon may not be responding yet."
    echo "    Check logs: $LOG_DIR/qmd-daemon.log"
fi
echo ""

# ─────────────────────────────────────────────────────────────────
# Step 8: Enable QMD in Cal config
# ─────────────────────────────────────────────────────────────────

echo -e "${BOLD}Step 8: Enabling QMD in Cal config...${NC}"
echo ""

COLLECTIONS_JSON="$(printf '%s\n' "${FINAL_FOLDERS[@]}" | node --input-type=module -e "const fs = await import('fs'); const input = fs.readFileSync(0, 'utf8').trim().split('\n').filter(Boolean); console.log(JSON.stringify(input));")"
update_jobs_config "$QMD_ENDPOINT" "$COLLECTIONS_JSON"
echo ""

# ─────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────

echo -e "${BLUE}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                    Setup Complete!                           ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"
echo ""
echo "QMD is now configured for Cal Gateway:"
echo ""
echo "  Collections indexed:"
for collection in "${FINAL_FOLDERS[@]}"; do
    echo "    • $collection/"
done
echo ""
echo "  HTTP endpoint: $QMD_ENDPOINT"
echo "  Daemon: Managed by launchd (auto-starts on boot)"
echo "  Logs: $LOG_DIR/qmd-daemon.log"
echo ""
echo -e "${BOLD}Next steps:${NC}"
echo ""
echo "  1. Restart Cal Gateway so it connects to QMD"
echo ""
echo "  2. Test it: Ask Cal to search for something in your files"
echo ""
echo -e "${BOLD}Useful commands:${NC}"
echo ""
echo "  qmd status              # Check collection status"
echo "  qmd update              # Refresh indexes (run after adding files)"
echo "  qmd embed               # Regenerate embeddings (weekly)"
echo "  curl $QMD_ENDPOINT      # Test HTTP endpoint"
echo ""
