---
name: handoff
description: Save conversation context to permanent memory before ending a session. Captures active work, decisions, artifacts, and routes them to appropriate files.
---

# Handoff Skill

You are being asked to perform a **handoff** — capturing the important context from this conversation before it ends or gets too long.

## Your Task

Analyze our conversation and save important context to permanent storage. This ensures continuity when we pick up later.

## What to Extract (5 Categories)

### 1. ACTIVE CONTEXT
What's happening right now:
- Current project/task and its status
- What was just completed
- What's next / open items
- Blockers or pending decisions

### 2. DECISIONS & CHANGES MADE
Important choices and modifications:
- Architectural decisions (and why)
- User preferences discovered
- Problems solved (problem → solution → why it worked)
- Configuration or approach changes

### 3. ARTIFACTS CREATED
What was built or modified:
- Files created (full paths!)
- Files modified (what changed, why)
- Code/scripts added
- Documents written

### 4. KNOWLEDGE DISCOVERED
New information learned:
- Facts about user's work
- Technical insights
- Important dates/deadlines
- People/teams/relationships
- Process learnings

### 5. FEEDBACK FOR CAL
How Cal should behave:
- Corrections (what not to do)
- Confirmations (what worked well)
- Preferences (how user wants Cal to work)

## Where to Save (Routing Rules)

Route each piece of information to the right place:

| Content Type | Destination |
|--------------|-------------|
| Today's events, tasks, meetings | `memory/YYYY-MM-DD.md` (use today's date) |
| Long-term facts, preferences | `context/MEMORY.md` |
| Cal architecture changes | `cal/` folder |
| Work project updates | `docs/projects/{project}/` |
| Personal items | `docs/personal/` |

## Execution Steps

1. **Analyze** the conversation — identify what's worth preserving
2. **Categorize** each item into the 5 categories above
3. **Write to daily log** — append a summary to `memory/YYYY-MM-DD.md`
4. **Update MEMORY.md** — add any long-term facts to `context/MEMORY.md`
5. **Report** — tell the user what you saved and where

## Output Format

After saving, report back concisely:

```
📝 Handoff Complete

**Saved to daily log** (memory/YYYY-MM-DD.md):
- [brief list of what was logged]

**Updated long-term memory** (context/MEMORY.md):
- [any facts added, or "No updates needed"]

**Files touched:**
- [list any other files written to]

Ready to continue or wrap up.
```

## Important Notes

- Only save things worth remembering — be selective
- Use bullet points, not paragraphs
- Include full file paths when referencing artifacts
- Don't say goodbye — we may continue the conversation
- If nothing important to save, just say "Nothing significant to capture from this session"

## Tools Available

Use these tools to complete the handoff:
- `read_file` — read existing files to check for duplicates
- `write_file` — create new files
- `edit_file` — update existing files (MEMORY.md, daily log)
- `bash` — run commands if needed (e.g., check date)
