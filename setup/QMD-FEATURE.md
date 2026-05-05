# QMD Feature - Semantic Search for Cal Gateway

## Overview

QMD (Query Markup Documents) provides semantic search capabilities for Cal, enabling intelligent retrieval across all memory files, documentation, and context.

**Status:** Optional feature (feature flag controlled)

---

## What QMD Provides

### Three-Layer Search
1. **BM25 (Keyword)** - Fast indexed keyword matching
2. **Vector Search** - Semantic understanding via embeddings
3. **LLM Re-ranking** - Final intelligent relevance scoring

### Architecture Benefits
- **Fast queries** - MCP client keeps connection to daemon, indexes stay in RAM
- **Semantic memory** - Finds connections even with different wording
- **No external APIs** - 100% local, runs on-device
- **MCP Protocol** - Standard protocol, reusable for other tools

---

## How It Works

### MCP Client Architecture

Cal Gateway uses the MCP (Model Context Protocol) client to communicate with the QMD daemon:

```
┌─────────────────────────────────────────────────┐
│ Cal Gateway                                      │
│                                                  │
│ ┌──────────────────────────────────────────┐   │
│ │ MCP Client Manager                       │   │
│ │ (src/mcp-client.js)                      │   │
│ │                                          │   │
│ │ - Manages connections to MCP servers     │   │
│ │ - Handles session lifecycle              │   │
│ │ - Provides tool discovery & calling      │   │
│ └──────────────────┬───────────────────────┘   │
│                    │                            │
│                    │ Streamable HTTP            │
│                    │ (MCP Protocol)             │
│                    ▼                            │
└────────────────────┼────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│ QMD Daemon (launchd-managed)                    │
│ http://localhost:<qmd-port>/mcp                 │
│                                                  │
│ - BM25 indexes in RAM                           │
│ - Vector embeddings in RAM                      │
│ - LLM models loaded                             │
│ - Fast queries (~35ms after warmup)             │
└─────────────────────────────────────────────────┘
```

### Performance

**First query after daemon start:** ~7 seconds (loads models)
**Subsequent queries:** ~35ms (200x faster!)

The MCP client maintains a persistent connection, so the daemon keeps indexes warm between queries.

---

## Installation

### Automated Setup (Recommended)

Run the setup script:

```bash
cd cal  # or cal-gateway in source repo
./setup/qmd-setup.sh
```

This will:
1. Install QMD globally via npm
2. Create collections (context, memory, docs, cal-arch)
3. Add context metadata
4. Generate initial indexes and embeddings
5. Choose an available local HTTP port, starting at 8181
6. Set up QMD daemon with launchd
7. Enable QMD in `config/jobs.json`
8. Verify HTTP endpoint is running

To request a specific local port:

```bash
./setup/qmd-setup.sh --port 8190
```

### Manual Setup

If you prefer manual control:

1. **Install QMD:**
   ```bash
   npm install -g @tobilu/qmd
   ```

2. **Create collections:**
   ```bash
   qmd collection add ~/harness/context --name context
   qmd collection add ~/harness/memory --name memory
   qmd collection add ~/harness/docs --name docs
   qmd collection add ~/harness/cal --name cal-arch
   ```

3. **Add context metadata:**
   ```bash
   qmd context add "qmd://cal-arch/architecture" \
     --text "Cal's architectural decisions and system design"
   
   qmd context add "qmd://docs/strategic" \
     --text "High-level strategic context for work"
   
   qmd context add "qmd://memory" \
     --text "Daily episodic memory logs"
   
   qmd context add "qmd://context" \
     --text "User profile and long-term memory"
   ```

4. **Initial indexing:**
   ```bash
   cd ~/harness
   qmd update    # BM25 indexes
   qmd embed     # Vector embeddings (takes a few minutes)
   ```

5. **Set up daemon:**
   - Copy `ai.qmd.daemon.plist` to `~/Library/LaunchAgents/`
   - Update paths in plist if needed
   - Load daemon: `launchctl load ~/Library/LaunchAgents/ai.qmd.daemon.plist`

---

## Enabling the Feature

The setup script updates `config/jobs.json` automatically. The resulting config looks like:

```json
{
  "features": {
    "qmd": {
      "enabled": true,
      "httpEndpoint": "http://localhost:<qmd-port>/mcp",
      "collections": ["context", "memory", "docs", "cal-arch"],
      "cronJobs": {
        "indexUpdate": "qmd-index-update",
        "embedUpdate": "qmd-embed-update"
      }
    }
  }
}
```

Restart Cal Gateway after setup:

```bash
launchctl restart ai.cal-gateway
```

---

## Usage

### Via iMessage or Telegram

Ask Cal to search:
- "What do I know about Agent SDK?"
- "Find connections between memory and learning projects"
- "When did I last talk to Tobias?"

Cal will use the `semantic_search` tool automatically.

### Via Terminal

```bash
qmd query "your search query"
qmd query "agent sdk" -c docs      # Search specific collection
qmd search "keyword"                # BM25 only (faster)
qmd vsearch "semantic query"        # Vector only
```

---

## Maintenance

### Automated (Recommended)

If QMD feature is enabled, these cron jobs run automatically:

- **Nightly (3:07 AM):** `qmd update` - refreshes BM25 indexes
- **Weekly (Sundays 3:19 AM):** `qmd embed` - regenerates vector embeddings

### Manual

```bash
qmd update              # Refresh indexes (fast, run after adding files)
qmd embed               # Regenerate embeddings (slow, run weekly)
qmd status              # Check index health
qmd cleanup             # Clear caches, vacuum database
```

---

## Verification

### Check daemon status:
```bash
launchctl list | grep qmd
curl http://localhost:<qmd-port>/mcp
```

### Check collections:
```bash
qmd collection list
qmd status
```

### Test search:
```bash
qmd query "test query"
```

---

## Disabling QMD

### Temporary (Keep Installation)

Set `features.qmd.enabled: false` in `jobs.json` and restart Gateway.

The daemon and indexes remain, just not used by Gateway.

### Permanent (Full Removal)

1. Stop daemon: `launchctl unload ~/Library/LaunchAgents/ai.qmd.daemon.plist`
2. Remove plist: `rm ~/Library/LaunchAgents/ai.qmd.daemon.plist`
3. Uninstall: `npm uninstall -g @tobilu/qmd`
4. Remove indexes: `rm -rf ~/.cache/qmd`
5. Set `features.qmd.enabled: false` in `jobs.json`

---

## Troubleshooting

### QMD daemon not starting

Check logs:
```bash
tail -f ~/harness/cal-gateway/logs/qmd-daemon-error.log
```

Common issues:
- QMD not in PATH → Update `EnvironmentVariables.PATH` in plist
- Working directory wrong → Check `WorkingDirectory` in plist
- Requested port already in use → rerun with `--port <port>` or let setup choose the next available port

### Search returns no results

- Check if collections exist: `qmd collection list`
- Verify indexes built: `qmd status`
- Try manual query: `qmd query "test"`
- Regenerate indexes: `qmd update && qmd embed`

### Slow first query

This is expected if:
- Daemon not running (spawns CLI instead)
- Daemon just started (loading indexes)
- OS evicted from memory (after long idle)

Solution: Ensure daemon is running and stays loaded.

---

## Architecture Notes

### Why MCP Client + HTTP Daemon?

**Without daemon (CLI mode):**
- Spawns new process per query
- Loads indexes fresh each time (~7s cold start)
- Every query pays the startup cost

**With MCP client + daemon:**
- One persistent daemon process
- Indexes stay in RAM
- MCP client maintains connection
- First query: ~7s (model loading)
- Subsequent queries: ~35ms (200x faster!)
- Survives machine restart (launchd managed)

**MCP-only (no CLI fallback):**
- Requires QMD daemon to be running
- Fails fast with clear error if daemon is down
- Simpler code, no redundant paths

### Why Feature Flag?

- **Optional complexity** - Not everyone needs semantic search
- **Resource usage** - Daemon uses ~500MB RAM, models use ~2GB disk
- **Setup time** - Initial embedding generation takes several minutes
- **Packaging** - Cal Gateway can be distributed without QMD dependency
- **MCP infrastructure** - Enables other MCP tools in the future

Users who want basic Cal (calendar, mail, notes, web search) don't need to install QMD.

Users who want advanced memory/search capabilities can opt in.

### MCP Client Benefits

The MCP client infrastructure (`src/mcp-client.js`) is reusable:
- Connect to any MCP server with one line
- Tool discovery is automatic
- Session lifecycle is managed
- PowerPoint MCP server ready to enable
- Future MCP tools just need endpoint config

---

## Performance

**Index size:** ~75 MB (1,900 files)  
**Models:** 2.2 GB total (embedding, reranker, generation)  
**RAM usage:** ~500 MB daemon + models loaded on-demand  

**Query speed (with MCP client):**
- First query: ~7 seconds (loads models into RAM)
- Subsequent queries: ~35ms (200x faster!)
- CLI fallback: ~7-25 seconds per query (always cold start)

**Collections:**
- context: 5 files
- memory: 24 files (daily logs)
- docs: 1,870 files (projects, strategic docs)
- cal-arch: 26 files (Cal architecture)

---

## Future Enhancements

- [ ] Auto-detect new files and trigger indexing
- [ ] Configurable collections via feature config
- [ ] Support for other MCP-compatible search tools
- [ ] Integration with Learning Extraction system
- [ ] Query result caching for repeated searches

---

**Last Updated:** April 6, 2026
