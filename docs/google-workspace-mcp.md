# Google Workspace MCP

Cal can optionally connect to Google Workspace through a local MCP wrapper over Google's open-source `gws` CLI.

The public distribution includes this as an optional external-service example of how to expose a narrow MCP server safely.

## Scope

Enabled tools:

- `google_drive_search_docs`
- `google_docs_read`
- `google_docs_create`
- `google_docs_batch_update`

Blocked in this wrapper:

- file delete/trash operations
- sharing and permission changes
- ownership transfer
- destructive Docs batch requests such as `deleteContentRange`
- non-Docs Workspace apps

Writes are two-step: the first create/update call returns a confirmation token and summary; the second matching call with that token performs the write.

## Setup

Install the Google Workspace CLI:

```bash
npm install -g @googleworkspace/cli
```

Authenticate:

```bash
gws auth setup
gws auth login
```

If `gws auth setup` cannot create credentials automatically, create a Google Cloud Desktop OAuth client manually and save the downloaded JSON to:

```text
~/.config/gws/client_secret.json
```

Then run:

```bash
gws auth login
gws auth status
```

Enable the server in `config/jobs.json` after copying from `config/jobs.example.json`:

```json
"google-workspace": {
  "enabled": true
}
```

Keep the existing `allowedTools` and `blockedToolPatterns` entries unless you have intentionally reviewed the safety boundary.
