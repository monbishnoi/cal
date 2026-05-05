---
name: brave-search
description: Search the web using Brave Search API. Use for AI news, research, and general web queries.
---

# Web Search via Brave API

**Script:** `scripts/brave-search.sh`

## Usage

```bash
scripts/brave-search.sh "your search query"
```

## Requirements

Requires `BRAVE_SEARCH_API_KEY` environment variable.

Store in: `config/.env`

```bash
export BRAVE_SEARCH_API_KEY="your-api-key-here"
```

## Why Use Brave API?

- **2,000 queries/month** on free tier
- **No CAPTCHA issues** (unlike Google)
- **Full control** over search parameters
- Works when the runtime does not provide native web search

## Common Search Examples

### News & Trends
```bash
brave-search.sh "[your industry] latest news"
brave-search.sh "[your topic] trends 2026"
brave-search.sh "site:news.ycombinator.com [topic]"
```

### Industry Research
```bash
brave-search.sh "[competitor] latest developments"
brave-search.sh "[technology] comparison"
brave-search.sh "[your domain] best practices"
```

### Technical Research
```bash
brave-search.sh "[framework/tool] tutorial"
brave-search.sh "[error message] solution"
brave-search.sh "site:github.com [project type]"
```

## Alternative: Runtime Web Search

Some assistant runtimes have built-in web search. Use it when:
- You need quick results
- Brave API quota is limited
- Search is simple

Use Brave when:
- You need consistent results
- Running automated news fetches
- WebSearch has issues

## Rate Limits

- Free tier: 2,000 queries/month
- Track usage to avoid hitting limits
- AI news digest (~4 queries/day) = ~120 queries/month
