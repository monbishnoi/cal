---
name: eod-wrap
description: Generate end-of-day wrap-up with accomplishments, pending items, and tomorrow preview. Run at 2:50 PM or on demand.
disable-model-invocation: true
---

# End-of-Day Wrap Generation

Generate a wrap-up briefing for the user's shutdown ritual.

## Step 1: Load Context Files

Read:
- `context/ACTION-ITEMS.md`
- `memory/!`date +%Y-%m-%d`.md` (today's log)

## Step 2: Review Accomplishments

- Today's memory file captures session work. Review for accomplishments.
- Compare ACTION-ITEMS.md priorities against what got done.
- Check calendar: `icalBuddy -f -ea -n eventsToday` (which meetings happened)

## Step 3: Check for Late-Day Emails

Run: `scripts/mail-reader.sh unread [account] 10`

Flag anything new and urgent that arrived during the day.

## Step 4: Check Tomorrow

```bash
icalBuddy -f -ea -n eventsToday+1
```

- Identify calendar gaps where focus blocks could go
- Look at ACTION-ITEMS.md for what's due soon

## Step 5: Generate Wrap

Use this EXACT format:

```
**Cal's Day Wrap** - [Day], [Month] [Date]

**WHAT WE GOT DONE**
- [Accomplishment] ✓
- [Meeting + key outcome] ✓
- [Progress made] ✓

If nothing tracked: "Light session day - no tracked work sessions."

**STILL PENDING**
Items that didn't get done + when to tackle them:
- [Item] - [Original priority] - Suggested: [when]

**LATE-DAY EMAILS**
Any new urgent emails that came in:
-> **[Sender]** - [Subject] - [What's needed]

If nothing urgent: "No new urgent emails since morning."

**TOMORROW'S PREVIEW**
Quick look at what's coming:
- [Key meetings with times]
- [Deadlines approaching]
- [Prep needed tonight/early morning]

**SUGGESTED TIME BLOCKS** (for tomorrow)
Based on calendar gaps:
- [Time gap] - [Task: finish pending item X]
- [Time gap] - [Reading block: stay current on Y]

Ask: "Want me to block any of these on your calendar?"
```

## Formatting Rules

- No markdown tables (some channels render them poorly)
- Use bullet points and bold
- Tone: warm, supportive, like a good closing conversation
- Keep shorter than morning brief (~3-5 min read)
- End with something encouraging
- Every word earns its place
