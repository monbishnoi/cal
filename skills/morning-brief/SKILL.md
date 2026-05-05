# Morning Brief Skill

Base directory for this skill: skills/morning-brief

---

## Purpose

A concise, intelligent morning briefing delivered at 6:45 AM. Not a data dump — a curated snapshot of what matters today.

**Design principle:** Scannable on phone while having coffee. 2-3 minute read max.

---

## When to Run

- **Automatic:** Cron job at 6:45 AM daily
- **Manual:** Type `/morning-brief` anytime

---

## Delivery

Output via configured channel (file or messaging).

---

## Content Structure

```
Good morning.

TODAY: [Day, Month Date]

MUST DO TODAY
• [Urgent/deadline item with why it's urgent]
• [Time-sensitive item]
(Max 3 items — only truly urgent)

YOUR DAY
• [HH:MM] Meeting/event - [key context]
• [HH:MM] Meeting/event - [who, what to prep]
(From calendar — only work hours)

DON'T FORGET
• [Personal appointment or commitment if applicable]
• [Important errand or deadline outside work]
• [Home or routine task from memory]
(Things that might slip through the cracks)

AI PULSE
• [Relevant to your work] - [1 line why it matters]
• [Big news overnight] - [1 line]
• [Interesting find] - [1 line]
(3 items max, with source links)

---
Have a good one. ☀️
```

---

## Data Sources

### 1. Action Items (MUST DO TODAY)
Read: `context/ACTION-ITEMS.md`
- Look for items marked URGENT or with deadlines today/tomorrow
- Look for items that have been open too long
- Prioritize by real-world consequence of missing them

### 2. Calendar (YOUR DAY)
Run:
```bash
icalBuddy -f -ea -n eventsToday
```
- Extract time, title, attendees
- Add context from memory if you know what the meeting is about
- Flag prep needed for important meetings

### 3. Personal Context (DON'T FORGET)
Read: `context/MEMORY.md`
- Check: Any recurring personal obligations
- Check: Any appointments (doctor, dentist, etc.)
- Check: Personal routines from memory (meditation, workout days)
- Check: Planned personal events

Also read yesterday's daily log for any carry-over personal items:
```bash
cat memory/$(date -v-1d +%Y-%m-%d).md
```

### 4. News (NEWS PULSE) — Optional
If configured, search for relevant news using Brave:
```bash
export BRAVE_SEARCH_API_KEY="your-api-key-here"
scripts/brave-search.sh "[your topics] latest news" 5
```

**Filter criteria:**
- Relevant to the user's configured interests (see context/MEMORY.md)
- Major announcements in their domain
- Skip: routine updates, hype pieces, unverified rumors

**Note:** Configure your topics of interest in `context/MEMORY.md` under a "News Topics" section.

---

## Execution Steps

1. **Get current date and day**
   ```bash
   date "+%A, %B %d"
   ```

2. **Read action items** — identify urgent/deadline items

3. **Read calendar** — extract today's schedule

4. **Read memory** — check for personal items, recurring tasks

5. **Search AI news** — get 3 relevant items

6. **Compose brief** — use the template above, keep it tight

7. **Output** — Return the formatted brief for the configured output channel

---

## Formatting Rules

- **No markdown tables** — Some channels render them poorly
- **Use bullet points** — scannable
- **Bold for emphasis** — but sparingly
- **Links as plain URLs** — Most channels auto-link them
- **Max 2000 characters** — Keep concise for mobile viewing

---

## Intelligence Layer

Don't just dump data. Think about:

- **What's actually urgent?** A meeting at 2 PM isn't urgent at 6:45 AM. A deadline today is.
- **What might they forget?** Personal items slip through when work is busy.
- **What's the one thing?** If they could only do one thing today, what should it be?
- **What's the prep?** For important meetings, what should they review first?

---

## Example Output

```
Good morning.

TODAY: Friday, March 27

MUST DO TODAY
• Complete quarterly report — due end of month
• Review project doc — stakeholder waiting for feedback

YOUR DAY
• 9:00 AM - Focus block (self-scheduled)
• 11:00 AM - Team sync
• 2:00 PM - Weekly standup

DON'T FORGET
• Personal appointment at 12:00 PM
• Morning routine done?
• Any personal plans tonight?

NEWS PULSE (if configured)
• [Relevant headline] — [source]
  [why it matters]
• [Relevant headline] — [source]
  [why it matters]

---
Have a good one.
```

---

_Last updated: March 26, 2026_
