# Memory Consolidation Skill

Base directory for this skill: skills/consolidate

---

## What This Skill Does

This is Cal's "sleep" process — inspired by how the human brain consolidates memories during sleep. It extracts important facts from the day's activity, compares them against existing memory, and updates long-term storage.

**Neuroscience parallel:** During sleep, the brain doesn't create new memories — it *refines* existing ones. Strongly-used connections are preserved; weak/redundant ones are pruned. This skill does the same for Cal's memory.

---

## When to Use

- **Manual:** Type `/consolidate` anytime
- **Automatic:** Nightly cron job (if configured)
- **Suggested triggers:**
  - End of a work session
  - Before switching major topics
  - After completing a significant task

---

## Input Sources

Read these files to extract today's learnings:

1. **Today's daily log:** `memory/YYYY-MM-DD.md`
2. **Current conversation:** The full conversation history in this session
3. **Existing memory:** `context/MEMORY.md`

---

## Extraction Categories

Extract facts into these 5 categories:

### 1. ABOUT THE USER
Personal facts that help Cal understand and serve the user better.
- Preferences (how they like things done)
- Values (what matters to them)
- Achievements (wins, milestones)
- Patterns (repeated behaviors, habits)
- Facts (role, family, schedule)

**Examples:**
- "Prefers assertive + collaborative tone in emails"
- "No em dashes in writing — signals AI-generated text"
- "Tuesday mornings are best for deep work"

### 2. WORK IN PROGRESS
Current state of projects and tasks.
- Projects (personal or professional, with status)
- Tasks achieved (completed today)
- Open questions (unresolved decisions)
- Decisions made (and why)
- Action items (next steps)

**Examples:**
- "Project proposal sent to stakeholders"
- "Decision: Use approach A instead of B because [reason]"
- "Open question: How to handle edge case X?"

### 3. THINGS LEARNED
New knowledge acquired today.
- Concepts (new ideas, frameworks)
- Insights (realizations, connections)
- Technical learnings (how things work)

**Examples:**
- "Learned about [concept] — key insight is [summary]"
- "Discovered that [tool/system] works by [mechanism]"
- "Read about [topic] — main takeaway is [insight]"

### 4. REFERENCES
Where to find things — people, places, processes, documents, links.
- People (who does what, contact info)
- Places (offices, locations)
- Processes (how things work, workflows)
- Documents (key files, specs, guides with paths)
- Links (URLs, repos, dashboards, tools)

**Examples:**
- "Jane Smith — PM for project X, based in Seattle"
- "Project Dashboard: https://pages.github.example.com/your-org/project-dashboard/"
- "Search script: scripts/search.sh"
- "Planning document: docs/projects/plan.md"

### 5. FEEDBACK FOR CAL
How Cal should behave — corrections and confirmed approaches.
- Corrections (what not to do)
- Confirmations (what worked well)
- Preferences (how the user wants Cal to work)

**Examples:**
- "Always explain what we're doing, why, and how — the user wants to learn"
- "Don't auto-delete contradictions — flag for review instead"
- "Research before executing — share findings before building"

---

## Consolidation Rules

For each extracted fact, compare against existing MEMORY.md:

### DUPLICATE (NOOP)
The fact already exists in memory with the same meaning.
- **Action:** Skip, don't add
- **Optional:** Note that this fact was reinforced (strengthening signal)

### UPDATE (MERGE)
The fact relates to something in memory but has new/updated information.
- **Action:** Merge the new info into the existing entry
- **Example:** "A teammate owns project planning" + "That teammate starts March 23" -> Merge into one entry

### CONTRADICT (FLAG)
The new fact contradicts something in existing memory.
- **Action:** DO NOT auto-delete. Flag for the user's review.
- **Output:** List contradictions separately with both old and new versions
- **Example:** Memory says "meeting Thursday" but new fact says "meeting moved to Friday"

### NEW (ADD)
The fact is genuinely new, not in memory.
- **Action:** Add to appropriate section of MEMORY.md

---

## Output Format

### 1. Update MEMORY.md

Modify `context/MEMORY.md` with:
- New facts added to appropriate sections
- Updated facts merged in place
- Keep the existing structure and formatting

### 2. Consolidation Log

Append to today's daily log (`memory/YYYY-MM-DD.md`):

```markdown
---

## Consolidation Log (HH:MM)

### Added
- [category] fact description

### Updated
- [category] what changed

### Flagged for Review
- CONTRADICTION: "old fact" vs "new fact" — which is correct?

### Reinforced (seen again)
- [category] fact that was already known

### Stats
- Facts extracted: N
- Added: N
- Updated: N
- Duplicates skipped: N
- Contradictions flagged: N
```

### 3. Contradictions Alert

If any contradictions were found, alert the user:

```
CONTRADICTIONS FOUND — Please review:

1. Memory says: "X"
   Today's input says: "Y"
   → Which is correct?

[List all contradictions]
```

---

## Execution Steps

When `/consolidate` is invoked:

1. **Announce start:**
   "Starting memory consolidation..."

2. **Read inputs:**
   - Read today's daily log
   - Review conversation history
   - Read existing MEMORY.md

3. **Extract facts:**
   - Go through inputs systematically
   - Categorize each fact into the 5 categories
   - Be selective — only extract facts worth remembering long-term

4. **Compare and decide:**
   - For each extracted fact, check against MEMORY.md
   - Classify as DUPLICATE, UPDATE, CONTRADICT, or NEW

5. **Write outputs:**
   - Update MEMORY.md with ADDs and UPDATEs
   - Append consolidation log to daily log
   - Report contradictions to the user

6. **Report summary:**
   "Consolidation complete. Added X, updated Y, flagged Z contradictions."

---

## Weekly Highlights (Optional)

On Sundays (or when asked), also generate:

**10 Highlights of the Week**
- Review the week's daily logs
- Extract the 10 most significant events/learnings/decisions
- Write to: `memory/weekly/YYYY-WNN.md`

---

## Design Principles

1. **Signal over noise:** Only extract facts worth remembering months from now
2. **Never auto-delete:** Contradictions are flagged, not resolved automatically
3. **Preserve context:** Include "why" when the reason matters
4. **Respect structure:** Work within MEMORY.md's existing organization
5. **Be transparent:** Always show what was added/updated/flagged

---

## Technical Notes

- This skill uses pure prompt-based consolidation (LLM reads and reasons over everything)
- Works well while memory is small (<100KB)
- Future enhancement: Add embeddings for semantic deduplication when memory grows
- Cron job should be durable (`durable: true`) and auto-renewed before expiry

---

_Last updated: March 26, 2026_
