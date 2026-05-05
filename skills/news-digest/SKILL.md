# News Digest Skill

**Schedule:** Daily (configure time in jobs.json)
**Channel:** Configured output (file or messaging)

---

## Purpose

Surface the latest news relevant to the user's interests and work. A curated digest, not a data dump.

**Design principle:** If the user only had 5 minutes to catch up, this is what they'd want to see.

---

## Configuration

**Before using this skill, customize for your interests:**

1. Edit `context/MEMORY.md` to include your topics of interest
2. Update search queries below to match your domain

### Example Topics Section (add to MEMORY.md)

```markdown
## News Topics
- [Your industry/domain]
- [Key technologies you follow]
- [Competitors to monitor]
- [Thought leaders in your space]
```

---

## Output Format

```
📰 News Digest — [Date]

🔥 BREAKING (if any)
[Major news in your domain]
→ Why it matters: [1 line]
→ Source: [URL]

📊 INDUSTRY NEWS
• [Headline] — [source]
  → [Why it matters]
• [Headline] — [source]
  → [Why it matters]

🌟 NOTABLE
• [Interesting development]
  → [Key takeaway]

💬 COMMUNITY BUZZ
• [Hot discussion/thread] — [community]
  → [Key takeaway]

---
```

**Not every section will have content every day.** Only include sections with something worth reporting.

---

## Execution Steps

1. **Get current date**

2. **Read user's topics** from `context/MEMORY.md`

3. **Run Brave searches** based on user's configured topics:
   ```bash
   # Customize these queries for your interests
   brave-search "[your topic 1] news today"
   brave-search "[your topic 2] latest"
   brave-search "site:reddit.com [your domain] trending"
   brave-search "site:news.ycombinator.com [your topic]"
   ```

4. **Filter & score results:**
   - Remove duplicates
   - Score relevance to user's work (high/medium/low)
   - Prioritize: breaking > directly relevant > trending

5. **Annotate each item** with "why it matters"

6. **Format** using template above

7. **Output** — Return the formatted digest

---

## Intelligence Layer

Don't just aggregate links. Think like the user's research analyst:

- **Connect to their work:** How does this news relate to what they're doing?
- **Spot trends:** "Third mention of [concept] this week — worth watching"
- **Surface surprises:** Things outside their usual radar they'd find interesting
- **Keep it brief:** Quality over quantity

---

## Customization Examples

### For a Software Engineer
```bash
brave-search "programming languages trends 2026"
brave-search "site:github.com trending"
brave-search "[your tech stack] news"
```

### For a Product Manager
```bash
brave-search "product management AI tools"
brave-search "[your industry] product launches"
brave-search "competitor analysis [your company]"
```

### For a Designer
```bash
brave-search "UX design trends 2026"
brave-search "design systems news"
brave-search "site:dribbble.com trending"
```

---

_Customize the search queries and topics to match your interests._
