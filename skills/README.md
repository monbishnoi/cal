# CAL Skills

These skills are distributable workflow templates for CAL Gateway. They must stay generic and safe to publish.

## Portability Rules

- **Machine-independent:** no absolute machine paths, hostnames, local ports, or assumptions about a specific laptop.
- **User-independent:** no personal names, accounts, calendars, mailboxes, schedules, family details, or organization-specific defaults.
- **Data-independent:** no live memory, session state, private notes, credentials, OAuth tokens, or personal transcripts.
- **Environment-independent:** optional tools must be described as requirements or setup choices, not assumed to exist.

Use placeholders such as `{{OBSIDIAN_VAULT_PATH}}`, `{{MAIL_ACCOUNT_NAME}}`, `{{PERSONAL_CALENDAR_NAME}}`, and `{{WORK_CALENDAR_NAME}}` when a value depends on the user's machine or setup.
