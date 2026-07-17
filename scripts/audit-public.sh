#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "Public distribution audit"
echo "========================="

FAIL=0

check_absent_path() {
  local path="$1"
  if [ -e "$path" ]; then
    echo "FAIL forbidden path present: $path"
    FAIL=1
  fi
}

check_absent_pattern() {
  local label="$1"
  local pattern="$2"
  if rg -n "$pattern" . \
    --glob '!node_modules/**' \
    --glob '!**/.git/**' \
    --glob '!scripts/audit-public.sh' \
    --glob '!**/*.png' \
    --glob '!**/*.jpg' \
    --glob '!**/*.jpeg' \
    --glob '!**/*.ico' >/tmp/cal-public-audit.txt; then
    echo "FAIL forbidden text found: $label"
    cat /tmp/cal-public-audit.txt
    FAIL=1
  else
    echo "OK $label"
  fi
}

check_absent_path "config/.env"
check_absent_path "config/user.json"
check_absent_path "config/jobs.json"
check_absent_path "config/imessage.json"
check_absent_path "data/oauth"
check_absent_path "data/sessions.json"
check_absent_path "data/last-handoff.json"
check_absent_path "src/autoheal.js"
check_absent_path "src/surgery.js"
check_absent_path "src/rollback.js"
check_absent_path "src/jira-oauth-provider.js"
check_absent_path "joule"

while IFS= read -r file; do
  if [ "$file" != "config/jobs.example.json" ]; then
    echo "FAIL runtime jobs/profile config present: $file"
    FAIL=1
  fi
done < <(find config -maxdepth 1 -type f -name 'jobs*.json' | sort)

check_absent_pattern "internal provider/vendor references" "(^|[^A-Za-z])SAP([^A-Za-z]|$)|(^|[^A-Za-z])sap([^A-Za-z]|$)|sap\\.com|github\\.tools|tools\\.sap|Hyperspace|hyperspace|Joule|BTP|I306141|Jira|jira|GenAI Hub|genai|genai-hub|Graph API|graph\\.microsoft"
check_absent_pattern "private self-healing references" "AutoHeal|autoheal|Wolverine|self-surgery"
check_absent_pattern "machine-specific paths" "/Users/I306141|/Users/[^/[:space:]]+/harness"
check_absent_pattern "personal identity references" "monika|Monika|mon\\.bishnoi"

# monbishnoi is the public repository owner; repository links are allowed in
# published documentation, but the personal-name audit above remains active.
if rg -n "monbishnoi" . \
  --glob '!node_modules/**' \
  --glob '!**/.git/**' \
  --glob '!scripts/audit-public.sh' \
  --glob '!README.md' \
  --glob '!docs/*.html' \
  --glob '!docs/voice.md' \
  --glob '!package.json' >/tmp/cal-public-audit.txt; then
  echo "FAIL forbidden text found: monbishnoi outside approved repository links"
  cat /tmp/cal-public-audit.txt
  FAIL=1
else
  echo "OK monbishnoi (only in approved repository links)"
fi
check_absent_pattern "secret-like values" "sk-ant-|xox[baprs]-|TELEGRAM_BOT_TOKEN=[0-9]{6,}:|ANTHROPIC_API_KEY=sk-"

if [ "$FAIL" -ne 0 ]; then
  echo ""
  echo "Public audit failed."
  exit 1
fi

echo ""
echo "Public audit passed."
