#!/bin/bash
# Setup iMessage Channel for Cal Gateway
#
# This script fully automates iMessage setup:
# 1. Installs imsg CLI (via Homebrew)
# 2. Guides through Full Disk Access permissions
# 3. Helps identify your Apple ID identities
# 4. Sends a test message to establish the chat
# 5. Automatically finds the chat ID
# 6. Configures user.json with all settings
# 7. Tests the full round-trip
#
# The only manual steps:
# - Grant Full Disk Access in System Settings (we open it for you)
# - On iPhone: optionally disable Cal's identity (for cleaner UX)
#
# Usage: ./setup-imessage.sh

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$SCRIPT_DIR" == */setup ]]; then
    CAL_DIR="$(dirname "$SCRIPT_DIR")"
elif [[ "$SCRIPT_DIR" == */scripts ]]; then
    CAL_DIR="$(dirname "$SCRIPT_DIR")"
else
    CAL_DIR="$SCRIPT_DIR"
fi

USER_JSON="$CAL_DIR/config/user.json"
IMSG_PATH="/opt/homebrew/bin/imsg"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║              iMessage Channel Setup for Cal                   ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# =============================================================================
# Step 1: Check/Install imsg CLI
# =============================================================================

echo -e "${BLUE}Step 1: Install imsg CLI${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if command -v imsg &> /dev/null; then
    IMSG_VERSION=$(imsg --version 2>/dev/null | head -1 || echo "installed")
    echo -e "${GREEN}✓ imsg is already installed${NC} ($IMSG_VERSION)"
    IMSG_PATH=$(which imsg)
else
    echo "imsg CLI is required to read/send iMessages from the terminal."
    echo ""

    # Check if Homebrew is installed
    if ! command -v brew &> /dev/null; then
        echo -e "${RED}Homebrew is not installed.${NC}"
        echo ""
        echo "Install Homebrew first:"
        echo '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
        echo ""
        exit 1
    fi

    echo "Installing imsg via Homebrew..."
    echo ""
    brew tap steipete/tap 2>/dev/null || true
    brew install steipete/tap/imsg

    if command -v imsg &> /dev/null; then
        echo ""
        echo -e "${GREEN}✓ imsg installed successfully${NC}"
        IMSG_PATH=$(which imsg)
    else
        echo -e "${RED}Failed to install imsg${NC}"
        exit 1
    fi
fi

echo ""

# =============================================================================
# Step 2: Full Disk Access Permission
# =============================================================================

echo -e "${BLUE}Step 2: Grant Full Disk Access${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "imsg needs Full Disk Access to read the Messages database."
echo ""

# Test if we can read the Messages database
if imsg chats --limit 1 --json &>/dev/null; then
    echo -e "${GREEN}✓ Full Disk Access already granted${NC}"
    FDA_GRANTED=true
else
    FDA_GRANTED=false
    echo -e "${YELLOW}Full Disk Access not yet granted.${NC}"
    echo ""
    echo "I'll open System Settings for you. Please:"
    echo ""
    echo "  1. Click the ${BOLD}+${NC} button"
    echo "  2. Navigate to: ${CYAN}$IMSG_PATH${NC}"
    echo "  3. Add it and ensure the toggle is ${GREEN}ON${NC}"
    echo ""
    echo "Also add your terminal app (Terminal.app or iTerm) if not already there."
    echo ""

    read -p "Press Enter to open System Settings → Privacy → Full Disk Access..."

    # Open System Settings to Full Disk Access
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"

    echo ""
    echo -e "${YELLOW}Waiting for you to grant permission...${NC}"
    echo "(This window will continue once you've added imsg)"
    echo ""

    # Wait for permission to be granted
    ATTEMPTS=0
    MAX_ATTEMPTS=60  # 5 minutes
    while ! imsg chats --limit 1 --json &>/dev/null; do
        sleep 5
        ATTEMPTS=$((ATTEMPTS + 1))
        if [ $ATTEMPTS -ge $MAX_ATTEMPTS ]; then
            echo -e "${RED}Timed out waiting for Full Disk Access.${NC}"
            echo "Please grant permission and run this script again."
            exit 1
        fi
        echo -n "."
    done

    echo ""
    echo -e "${GREEN}✓ Full Disk Access granted${NC}"
    FDA_GRANTED=true
fi

echo ""

# =============================================================================
# Step 3: Identify Apple ID Identities
# =============================================================================

echo -e "${BLUE}Step 3: Configure Identities${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "iMessage uses Apple ID identities (phone numbers and emails)."
echo "You likely have multiple identities linked to your Apple ID."
echo ""
echo "We need to assign:"
echo "  • ${BOLD}Your identity${NC} — The phone/email you message FROM (on your iPhone)"
echo "  • ${BOLD}Cal's identity${NC} — The phone/email Cal responds AS (on your Mac)"
echo ""
echo -e "${CYAN}Example:${NC}"
echo "  You: +1 415-555-1234 (your phone number)"
echo "  Cal: yourname@icloud.com (your iCloud email)"
echo ""
echo "To see your identities, open Messages.app → Settings → iMessage"
echo ""

# Get user's identity (allowedSender)
echo -e "${BOLD}Your Identity${NC} (the phone number or email you'll message Cal from):"
echo "  Format: +14155551234 or email@example.com"
echo ""
read -p "  Your identity: " USER_IDENTITY

if [ -z "$USER_IDENTITY" ]; then
    echo -e "${RED}Identity is required.${NC}"
    exit 1
fi

# Normalize phone number (remove spaces, dashes)
USER_IDENTITY=$(echo "$USER_IDENTITY" | tr -d ' -.()')

echo ""

# Get Cal's identity (calIdentity)
echo -e "${BOLD}Cal's Identity${NC} (the email or phone Cal will use to respond):"
echo "  This should be different from your identity above."
echo "  Typically your @icloud.com email works well."
echo ""
read -p "  Cal's identity: " CAL_IDENTITY

if [ -z "$CAL_IDENTITY" ]; then
    echo -e "${RED}Cal's identity is required.${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}✓ Identities configured${NC}"
echo "  You: $USER_IDENTITY"
echo "  Cal: $CAL_IDENTITY"
echo ""

# =============================================================================
# Step 4: Configure Mac Messages.app
# =============================================================================

echo -e "${BLUE}Step 4: Configure Messages.app on Mac${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "On your Mac, Messages.app should ONLY use Cal's identity."
echo "This ensures Cal responds from the right address."
echo ""
echo "Please verify in Messages.app → Settings → iMessage:"
echo "  ☑ ${GREEN}$CAL_IDENTITY${NC} (Cal's identity — should be checked)"
echo "  ☐ ${YELLOW}$USER_IDENTITY${NC} (Your identity — should be UNchecked)"
echo ""
echo "  'Start new conversations from:' → ${GREEN}$CAL_IDENTITY${NC}"
echo ""

read -p "Press Enter once you've configured Messages.app on your Mac..."
echo ""

# =============================================================================
# Step 5: Send Test Message to Establish Chat
# =============================================================================

echo -e "${BLUE}Step 5: Establish the Chat${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Now we need to create a conversation between you and Cal."
echo ""
echo -e "${CYAN}On your iPhone:${NC}"
echo "  1. Open Messages"
echo "  2. Start a new message TO: ${GREEN}$CAL_IDENTITY${NC}"
echo "  3. Send any message (e.g., 'Hello Cal')"
echo ""
echo "This creates the chat thread that Cal will monitor."
echo ""

read -p "Press Enter after you've sent a message from your iPhone..."
echo ""

# Wait a moment for the message to sync
echo "Waiting for message to sync to Mac..."
sleep 3

# =============================================================================
# Step 6: Find the Chat ID
# =============================================================================

echo -e "${BLUE}Step 6: Find Chat ID${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Get recent chats and find the one with the user's identity
echo "Scanning recent conversations..."
echo ""

CHATS_JSON=$(imsg chats --limit 30 --json 2>/dev/null || echo "[]")

# Try to find the chat by looking for user's identity in participants
# imsg returns chats with participant info
CHAT_ID=""

# Parse JSON to find matching chat
# Look for chats where the user's identity appears
if command -v jq &> /dev/null; then
    # Use jq if available for reliable parsing
    CHAT_ID=$(echo "$CHATS_JSON" | jq -r --arg sender "$USER_IDENTITY" '
        .[] |
        select(
            (.participants[]? | test($sender; "i")) or
            (.display_name? | test($sender; "i")) or
            (.chat_identifier? | contains($sender))
        ) |
        .id' 2>/dev/null | head -1)
fi

# If jq not available or didn't find it, try grep-based approach
if [ -z "$CHAT_ID" ]; then
    # Extract last 10 digits of phone for matching
    USER_PHONE_SUFFIX=$(echo "$USER_IDENTITY" | grep -oE '[0-9]+' | tail -c 11)

    # Look for the chat ID in the JSON output
    CHAT_ID=$(echo "$CHATS_JSON" | grep -B5 "$USER_PHONE_SUFFIX" | grep '"id"' | head -1 | grep -oE '[0-9]+' | head -1)
fi

if [ -z "$CHAT_ID" ]; then
    echo -e "${YELLOW}Could not automatically find the chat ID.${NC}"
    echo ""
    echo "Here are your recent chats:"
    echo ""
    imsg chats --limit 10
    echo ""
    echo "Find the chat with ${BOLD}$USER_IDENTITY${NC} and enter its ID:"
    read -p "  Chat ID: " CHAT_ID

    if [ -z "$CHAT_ID" ]; then
        echo -e "${RED}Chat ID is required.${NC}"
        exit 1
    fi
else
    echo -e "${GREEN}✓ Found chat ID: $CHAT_ID${NC}"
    echo ""

    # Show the chat to confirm
    echo "Verifying this is the correct chat..."
    imsg history --chat-id "$CHAT_ID" --limit 3 2>/dev/null || true
    echo ""

    read -p "Is this the correct chat? (Y/n): " CONFIRM
    if [[ "$CONFIRM" =~ ^[Nn] ]]; then
        echo ""
        echo "Here are your recent chats:"
        imsg chats --limit 10
        echo ""
        read -p "Enter the correct Chat ID: " CHAT_ID
    fi
fi

echo ""

# =============================================================================
# Step 7: Update user.json Configuration
# =============================================================================

echo -e "${BLUE}Step 7: Save Configuration${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Create config directory if needed
mkdir -p "$CAL_DIR/config"

# Check if user.json exists
if [ -f "$USER_JSON" ]; then
    echo "Updating existing user.json..."

    # Use a temp file for safe editing
    TEMP_JSON=$(mktemp)

    if command -v jq &> /dev/null; then
        # Use jq for reliable JSON editing
        jq --arg sender "$USER_IDENTITY" \
           --arg identity "$CAL_IDENTITY" \
           --arg chatId "$CHAT_ID" \
           '.imessage = {
               "enabled": true,
               "allowedSender": $sender,
               "calIdentity": $identity,
               "watchChatId": $chatId,
               "service": "imessage"
           }' "$USER_JSON" > "$TEMP_JSON"

        mv "$TEMP_JSON" "$USER_JSON"
    else
        # Fallback: Use sed for basic update (less reliable)
        # This is a simplified approach - may not work for all JSON structures
        echo -e "${YELLOW}Note: Installing jq would make config updates more reliable${NC}"
        echo "  brew install jq"
        echo ""

        # Check if imessage section exists
        if grep -q '"imessage"' "$USER_JSON"; then
            # Update existing imessage section using Python (available on macOS)
            python3 -c "
import json
with open('$USER_JSON', 'r') as f:
    config = json.load(f)
config['imessage'] = {
    'enabled': True,
    'allowedSender': '$USER_IDENTITY',
    'calIdentity': '$CAL_IDENTITY',
    'watchChatId': '$CHAT_ID',
    'service': 'imessage'
}
with open('$USER_JSON', 'w') as f:
    json.dump(config, f, indent=2)
"
        else
            # Add imessage section using Python
            python3 -c "
import json
with open('$USER_JSON', 'r') as f:
    config = json.load(f)
config['imessage'] = {
    'enabled': True,
    'allowedSender': '$USER_IDENTITY',
    'calIdentity': '$CAL_IDENTITY',
    'watchChatId': '$CHAT_ID',
    'service': 'imessage'
}
with open('$USER_JSON', 'w') as f:
    json.dump(config, f, indent=2)
"
        fi
    fi
else
    # Create new user.json
    echo "Creating user.json..."

    # Prompt for user's name
    read -p "What's your name? " USER_NAME
    USER_NAME=${USER_NAME:-User}

    cat > "$USER_JSON" << EOF
{
  "name": "$USER_NAME",
  "timezone": "$(date +%Z)",
  "locale": "en-US",
  "greeting": "Hey {{name}}!",
  "sessionPrefix": "$(echo "$USER_NAME" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z')",
  "assistant": {
    "name": "Cal",
    "description": "Thinking partner and executive assistant"
  },
  "imessage": {
    "enabled": true,
    "allowedSender": "$USER_IDENTITY",
    "calIdentity": "$CAL_IDENTITY",
    "watchChatId": "$CHAT_ID",
    "service": "imessage"
  }
}
EOF
fi

echo -e "${GREEN}✓ Configuration saved to user.json${NC}"
echo ""

# =============================================================================
# Step 8: Test the Setup
# =============================================================================

echo -e "${BLUE}Step 8: Test iMessage Integration${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

echo "Sending a test message from Cal to verify everything works..."
echo ""

TEST_MESSAGE="👋 Cal is now connected to iMessage! Setup complete at $(date '+%H:%M')."

if imsg send --chat-id "$CHAT_ID" --text "$TEST_MESSAGE" 2>/dev/null; then
    echo -e "${GREEN}✓ Test message sent successfully!${NC}"
    echo ""
    echo "Check your iPhone — you should see Cal's message."
else
    echo -e "${YELLOW}⚠ Could not send test message.${NC}"
    echo "  This might be a permissions issue. Try:"
    echo "  1. Open Messages.app on your Mac"
    echo "  2. Grant Automation permission if prompted"
    echo ""
fi

# =============================================================================
# Step 9: iPhone Configuration (Optional)
# =============================================================================

echo ""
echo -e "${BLUE}Step 9: iPhone Configuration (Optional)${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "For the cleanest experience on your iPhone, disable Cal's identity"
echo "so messages to Cal appear as a separate contact."
echo ""
echo -e "${CYAN}On your iPhone:${NC}"
echo "  Settings → Messages → Send & Receive"
echo ""
echo "  ☑ ${GREEN}$USER_IDENTITY${NC} (Your identity — keep checked)"
echo "  ☐ ${YELLOW}$CAL_IDENTITY${NC} (Cal's identity — UNCHECK this)"
echo ""
echo "This way, your iPhone only sends/receives as 'you',"
echo "and conversations with Cal appear separately."
echo ""
echo -e "${YELLOW}This step is optional${NC} — Cal works either way."
echo ""

# =============================================================================
# Done!
# =============================================================================

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo -e "${GREEN}${BOLD}✅ iMessage Setup Complete!${NC}"
echo ""
echo "Configuration saved:"
echo "  Your identity:  $USER_IDENTITY"
echo "  Cal's identity: $CAL_IDENTITY"
echo "  Chat ID:        $CHAT_ID"
echo ""
echo "Next steps:"
echo "  1. Restart Cal Gateway to enable iMessage:"
echo "     ${CYAN}pm2 restart cal-gateway${NC}"
echo "     (or: launchctl unload/load ~/Library/LaunchAgents/ai.cal.gateway.plist)"
echo ""
echo "  2. Send a message to Cal from your iPhone!"
echo ""
echo "Troubleshooting:"
echo "  • If Cal doesn't respond, check: pm2 logs cal-gateway"
echo "  • Ensure Mac doesn't sleep (use Amphetamine app)"
echo "  • Verify Full Disk Access for imsg and node"
echo ""
