---
name: calendar-ops
description: Read and manage Apple Calendar events. Use for checking schedule, creating events, or viewing upcoming meetings.
---

# Calendar Operations

## Reading Calendar (icalBuddy)

### Today's Events
```bash
icalBuddy -f -ea -n eventsToday
```

### Tomorrow
```bash
icalBuddy -f -ea -n eventsToday+1
```

### This Week
```bash
icalBuddy -f -ea -n eventsToday+7
```

### Specific Date Range
```bash
icalBuddy -f -ea eventsFrom:2026-03-17 to:2026-03-20
```

## Creating Events (AppleScript)

### Personal Events -> Configured Personal Calendar
```bash
osascript -e 'tell application "Calendar"
    tell calendar "{{PERSONAL_CALENDAR_NAME}}"
        make new event with properties {summary:"Event Title", start date:date "March 18, 2026 at 10:00:00 AM", end date:date "March 18, 2026 at 11:00:00 AM", description:"Optional notes"}
    end tell
end tell'
```

### Work Blockers -> Configured Work Calendar
```bash
osascript -e 'tell application "Calendar"
    tell calendar "{{WORK_CALENDAR_NAME}}"
        make new event with properties {summary:"Focus Block", start date:date "March 18, 2026 at 2:00:00 PM", end date:date "March 18, 2026 at 4:00:00 PM"}
    end tell
end tell'
```

## Important Notes

### Calendar Selection
- Configure calendar names during setup. Do not assume every Mac has the same personal or work calendar names.
- Use the user's selected personal calendar for personal events.
- Use the user's selected work/default calendar for meetings and focus blocks.

### Known Issues
- Some synced calendar events may have trailing spaces in titles - use `contains` not exact match when searching
- Modifying synced calendar events can time out - create new rather than modify
- icalBuddy uses relative dates ("tomorrow", "day after tomorrow") in output

### Date Format for AppleScript
Use format: `"Month DD, YYYY at HH:MM:SS AM/PM"`
Example: `"March 18, 2026 at 10:00:00 AM"`

## Common Tasks

### Quick Check Before Meeting
```bash
icalBuddy -f -ea -n eventsToday | grep -i "meeting"
```

### Find Free Time Tomorrow
```bash
icalBuddy -f -ea -n eventsToday+1
```
Look for gaps between events.

### Create Focus Block
Use the work calendar AppleScript template with summary like "Focus Block: [Task]"
