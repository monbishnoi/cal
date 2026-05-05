# End-of-Day Brief Skill

Base directory for this skill: skills/eod-brief

---

## Purpose

A reflective evening briefing delivered at 8:00 PM. Summarizes what was accomplished today and sets up tomorrow.

**Design principle:** Close the loop on the day. Acknowledge wins, surface carry-overs, preview tomorrow.

---

## When to Run

- **Automatic:** Cron job at 8:00 PM daily
- **Manual:** Type `/eod-brief` anytime

---

## Content Structure

```
Good evening.

TODAY'S WINS
• [Accomplishment with context]
• [Task completed]
• [Progress made on X]
(What actually got done — celebrate it)

CARRY-OVER
• [Item not completed — brief reason if known]
• [Item that needs follow-up tomorrow]
(No guilt — just awareness)

TOMORROW PREVIEW
• [Day, Date]
• [HH:MM] First meeting/event
• [HH:MM] Key meeting to prep for
• [Deadline or urgent item]
(What's coming so you can mentally prep)

OPEN BLOCKS
• [Time slot with no meetings] — want me to block this for something?
(Identify free time for deep work)

---
Rest well. You did good today.
```

---

## Data Sources

### 1. Today's Daily Log (TODAY'S WINS + CARRY-OVER)
Read: `memory/YYYY-MM-DD.md` (today's date)

Look for:
- Accomplishments marked with ✅
- Items completed during the day
- Decisions made
- Work mentioned in conversation

If the daily log is sparse, check the conversation history for context.

### 2. Action Items (CARRY-OVER)
Read: `context/ACTION-ITEMS.md`
- Items that were due today but not marked complete
- Items that were worked on but not finished

### 3. Tomorrow's Calendar (TOMORROW PREVIEW)
Run:
```bash
icalBuddy -f -ea -n eventsTomorrow
```
- Extract key meetings
- Note any that need prep
- Check for early morning meetings (affects wake-up)

### 4. Tomorrow's Open Blocks (OPEN BLOCKS)
Run:
```bash
icalBuddy -f -ea -n eventsTomorrow
```
- Identify gaps between meetings
- Gaps > 1 hour are worth mentioning
- Offer to block time for specific tasks

---

## Execution Steps

1. **Get current date**
   ```bash
   date "+%Y-%m-%d"
   ```

2. **Read today's daily log** — extract accomplishments and activity

3. **Read action items** — identify incomplete items

4. **Read tomorrow's calendar** — get schedule preview

5. **Identify open blocks** — find unscheduled time

6. **Compose brief** — use the template, keep it warm and reflective

7. **Output** — Return the formatted brief for the configured output channel

---

## Formatting Rules

- **No markdown tables** — Some channels render them poorly
- **Use bullet points** — scannable
- **Warm tone** — end of day, not a status report
- **Acknowledge effort** — even partial progress counts
- **Max 2000 characters** — Keep concise for mobile viewing

---

## Intelligence Layer

This is a reflection moment, not a task dump. Think about:

- **What actually happened?** Even if the log is sparse, what do you know from context?
- **What's the win?** Find something to acknowledge, even on hard days.
- **What's realistic for tomorrow?** Don't overwhelm with carry-overs.
- **What needs prep tonight?** If there's a big meeting tomorrow morning, mention it.

---

## Example Output

```
Good evening.

TODAY'S WINS
• Cal Gateway v0.2.0 shipped — unified daemon running with shared session context
• Capability inventory documented — source of truth for Cal's capabilities
• Architecture docs updated — OVERVIEW.md now reflects Gateway

CARRY-OVER
• Presentation planning — waiting on stakeholder availability
• Project playbook — sync with team tomorrow

TOMORROW PREVIEW
• Wednesday, April 1
• 9:00 AM - Weekly team standup
• 11:00 AM - Cross-team sync call
• 2:00 PM - 1:1 with manager

OPEN BLOCKS
• 10:00-11:00 AM free — want me to block for SDK doc review?
• 3:00-5:00 PM open — good for deep work

---
Rest well. You did good today.
```

---

_Last updated: March 31, 2026_
