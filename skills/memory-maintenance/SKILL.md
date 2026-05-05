---
name: memory-maintenance
description: Review recent daily logs and update MEMORY.md with significant learnings. Run weekly or on demand to keep long-term memory current.
disable-model-invocation: true
---

# Memory Maintenance Protocol

Run this periodically (weekly recommended) to keep MEMORY.md current and useful.

## Overview

- **Daily logs** (`memory/YYYY-MM-DD.md`) = raw notes, what happened
- **MEMORY.md** (`context/MEMORY.md`) = curated wisdom, long-term memory

Like a human reviewing their journal and updating their mental model.

## Step 1: Read Recent Daily Logs

Read the last 7 days of daily logs from:
`memory/`

List available files:
```bash
ls -la memory/
```

## Step 2: Identify Significant Items

Look for items worth adding to MEMORY.md:

**Personal Context:**
- Family updates (schedules, milestones)
- Health appointments or changes
- Routine changes

**Professional Context:**
- New colleagues or contacts
- Project milestones or pivots
- Important meetings and outcomes
- Deadlines or commitments made

**Working Relationship:**
- What worked well in our collaboration
- Preferences discovered
- Tools or approaches that helped

**Lessons Learned:**
- Problems solved (and how)
- Mistakes to avoid
- Insights or "aha" moments

## Step 3: Update MEMORY.md

Read current: `context/MEMORY.md`

**Add:**
- New learnings to appropriate sections
- Updated status on projects
- New contacts with context

**Remove:**
- Outdated information
- Completed items that no longer need tracking
- Stale context

**Keep it under 300 lines** - if getting too long, prioritize and trim.

## Step 4: Archive Old Daily Logs (Optional)

If daily logs are piling up (30+ days):

```bash
mkdir -p memory/archive
mv memory/2026-02-*.md memory/archive/
```

Keep recent 30 days active, archive the rest.

## Step 5: Update Timestamp

At the top of MEMORY.md, update:
```markdown
_Last updated: [Today's date]_
```

## Output

After completing maintenance, summarize:
- Items added to MEMORY.md
- Items removed or updated
- Any patterns noticed
- Suggested improvements

## Schedule

Recommended: Run every Sunday evening or Monday morning as part of weekly planning.

Can also run:
- After major project completions
- After significant life events
- When MEMORY.md feels stale
