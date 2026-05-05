---
name: notes-reader
description: Read Apple Notes (read-only). Use for accessing meeting notes, raw context, or personal notes the user has captured.
---

# Notes Reader (READ-ONLY)

Access Apple Notes via AppleScript. Read-only operations only.

## List All Notes

```bash
osascript -e 'tell application "Notes"
    set noteList to {}
    repeat with n in notes
        set end of noteList to name of n
    end repeat
    return noteList
end tell'
```

## Read Note by Name

```bash
osascript -e 'tell application "Notes"
    set noteText to body of note "Note Name Here"
    return noteText
end tell'
```

Replace "Note Name Here" with the exact note title.

## List Folders

```bash
osascript -e 'tell application "Notes"
    set folderList to {}
    repeat with f in folders
        set end of folderList to name of f
    end repeat
    return folderList
end tell'
```

## List Notes in Specific Folder

```bash
osascript -e 'tell application "Notes"
    set noteList to {}
    tell folder "FolderName"
        repeat with n in notes
            set end of noteList to name of n
        end repeat
    end tell
    return noteList
end tell'
```

## Search Notes (by title)

```bash
osascript -e 'tell application "Notes"
    set noteList to {}
    repeat with n in notes
        if name of n contains "search term" then
            set end of noteList to name of n
        end if
    end repeat
    return noteList
end tell'
```

## Common Use Cases

### Find Meeting Notes
Search for notes containing meeting-related terms:
- "meeting"
- "notes"
- Date patterns like "Mar 17"

### Access Raw Context
Users often capture raw notes quickly in Apple Notes. Useful for:
- Pre-meeting context
- Quick thoughts they captured
- Reference material

## Notes

- Apple Notes returns HTML-formatted content
- Some formatting may need cleanup for readability
- Note names are exact matches unless using `contains`
- READ-ONLY: Never modify or delete notes
