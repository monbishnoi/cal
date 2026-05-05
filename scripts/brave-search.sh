#!/bin/bash
# Brave Search API
# Usage: brave-search.sh "your search query" [count]

QUERY="$1"
COUNT="${2:-5}"

if [ -z "$QUERY" ]; then
  echo "Usage: brave-search.sh \"search query\" [count]"
  exit 1
fi

API_KEY="${BRAVE_SEARCH_API_KEY}"
if [ -z "$API_KEY" ]; then
  echo "Error: BRAVE_SEARCH_API_KEY not set"
  exit 1
fi

ENCODED_QUERY=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$QUERY'))")

curl -s "https://api.search.brave.com/res/v1/web/search?q=${ENCODED_QUERY}&count=${COUNT}" \
  -H "Accept: application/json" \
  -H "Accept-Encoding: gzip" \
  -H "X-Subscription-Token: ${API_KEY}" \
  --compressed | jq -r '
    .web.results[] |
    "## \(.title)\n\(.url)\n\(.description)\n"
  '
