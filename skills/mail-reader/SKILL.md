---
name: mail-reader
description: Read Apple Mail messages (read-only). Use for checking emails, scanning inbox, or reading specific messages. NEVER sends or modifies emails.
---

# Mail Reader (READ-ONLY)

**Script:** `scripts/mail-reader.sh`

**Policy:** READ-ONLY. No send, reply, forward, delete, or move operations.

## Commands

### List Accounts
```bash
scripts/mail-reader.sh accounts
```

### Count Messages
```bash
scripts/mail-reader.sh count [account]
```
Omit account to use the first configured Apple Mail account. Fast operation.

### List Unread Messages
```bash
scripts/mail-reader.sh unread [account] [limit]
```
Example: `mail-reader.sh unread "{{MAIL_ACCOUNT_NAME}}" 20`

### List Recent Messages
```bash
scripts/mail-reader.sh recent [account] [limit]
```

### Read Specific Message
```bash
scripts/mail-reader.sh read <message-id>
```
Message IDs are numeric (from unread/recent output).

### Search Messages
```bash
scripts/mail-reader.sh search <query> [account] [limit]
```
Searches both subject AND sender.

### Brief Summary
```bash
scripts/mail-reader.sh summary [account] [limit]
```

## Usage Notes

- Omit account to use the first configured Apple Mail account
- Large mailboxes can be slow - **always use limits** to avoid long queries
- For quick checks: use `count` (fastest)
- For morning briefs: use `unread [account] 20`
- Message IDs are numeric from Apple Mail internal IDs

## Urgency Criteria

When reviewing emails, flag as urgent if score 2+:
- User in TO (not just CC) - 1 point
- Direct question/request for the user - 1 point
- From key colleague/leadership - 1 point
- References today's meeting - 1 point
- Deadline within 48h - 1 point
- Part of active project - 1 point
- From senior stakeholders - 1 point

## Key Colleagues to Watch For

Configure this list in MEMORY.md with colleagues whose emails are high priority.

Example format:
- [Name] ([Role])
- [Name] ([Team/Location])
- [Name] ([Title])

## Security Notes

- macOS Automation permission grants Mail access at OS level
- This script intentionally excludes ALL write AppleScript commands
- All exec commands logged in session history
- **NEVER** attempt to send, delete, or modify emails
