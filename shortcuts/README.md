# Apple Shortcuts for Cal

This folder contains Apple Shortcuts that give Cal the ability to write to your calendar and reminders.

## Shortcuts to Import

1. **Cal-CreateEvent.shortcut** — Create calendar events
2. **Cal-CreateReminder.shortcut** — Create reminders

## How to Install

1. Double-click each `.shortcut` file to import into the Shortcuts app
2. On first run, grant permission when prompted:
   - "Allow Cal-CreateEvent to access your calendars?" → **Always Allow**
   - "Allow Cal-CreateReminder to access your reminders?" → **Always Allow**

## Why Shortcuts?

macOS sandboxing prevents direct calendar/reminder writes. Apple Shortcuts provide a secure, user-approved way to write to these apps.

Cal can read calendars directly (via icalBuddy), but writes go through these shortcuts.

## Creating the Shortcuts

If the shortcut files aren't included, create them manually:

### Cal-CreateEvent
1. Open Shortcuts app
2. Create new shortcut named "Cal-CreateEvent"
3. Add action: "Add New Event"
4. Configure inputs: Title, Start Date, End Date, Calendar, Notes
5. Save

### Cal-CreateReminder
1. Open Shortcuts app  
2. Create new shortcut named "Cal-CreateReminder"
3. Add action: "Add New Reminder"
4. Configure inputs: Title, Due Date, Notes, List
5. Save

Cal calls these via: `shortcuts run "Cal-CreateEvent" --input-path /tmp/event.json`
