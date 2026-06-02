# Google Workspace MCP Wrapper

CAL Phase 1 Google Workspace access uses Google's open-source `gws` CLI as the API backend and exposes a small local MCP surface:

- `google_drive_search_docs`
- `google_docs_read`
- `google_docs_create`
- `google_docs_batch_update`

Phase 1 intentionally does not expose delete, trash, sharing, permission, owner transfer, Gmail, Calendar, Sheets, or Slides tools.

## Safety Rails

- Search/read tools execute immediately.
- Create/update tools require a confirmation token before any Google Docs write runs.
- Docs batch updates reject destructive request types such as `deleteContentRange`.
- Cal Gateway also allowlists the exact four tool names in `config/jobs.json`.

## Setup

Install the Google Workspace CLI:

```bash
npm install -g @googleworkspace/cli
```

Authenticate the CLI:

```bash
gws auth setup
gws auth login
```

`gws auth setup` requires `gcloud`. Without `gcloud`, create a Google Cloud Desktop OAuth client manually and save the downloaded JSON to `~/.config/gws/client_secret.json`, then run `gws auth login`.

Then restart Cal Gateway:

```bash
pm2 restart cal-gateway
```

The CLI stores credentials outside this repository. Do not add exported Google credentials to the harness repo.
