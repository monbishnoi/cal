# CAL As A System Steward

CAL is not trying to be another model console.

The major AI clients already provide powerful hands: coding tools, browser tools, file tools, connectors, and cloud agents. CAL's role is different. CAL is a local continuity layer that helps steward a system over time.

That system might be a life, a household, a business, a product, a team, a customer portfolio, or an engineering system.

## The Core Idea

A System Steward maintains a coherent model of a system and helps preserve its health over time.

Traditional tools help with tasks. Dashboards show state. Assistants answer prompts. A steward keeps context, notices drift, routes attention, remembers what matters, and helps the system stay aligned with its goals.

## Why This Matters

Many AI consoles are powerful in the moment, but the continuity lives somewhere else:

- in a cloud account
- inside one vendor's product memory
- inside one chat thread
- inside a project file the user has to maintain manually

CAL makes continuity user-owned. Memory, sessions, routines, handoffs, and local context live in files and folders you control.

## The Steward Roles

| Steward Role | What It Means | CAL Today |
|--------------|---------------|-----------|
| Gateway | Routes attention to what matters | Channels, skills, tools, scheduled briefs |
| Custodian | Maintains valuable state | `context/`, `memory/`, session store, handoff files |
| Witness | Observes patterns over time | Daily logs, memory consolidation, recurring reviews |
| Advocate | Represents the system's interests | Briefs, pushback prompts, Auto Heal review proposals |
| Membrane | Makes boundary judgments | Optional integrations, explicit config, local/private defaults |
| Evolver | Improves the steward itself | Skills, memory maintenance, repair proposals, future self-improvement |

## Current Shape

The public release focuses on a personal steward:

- Web UI / PWA as the default mobile-friendly surface
- Terminal access for deep work
- Optional Telegram and iMessage channels
- Local memory and session continuity
- Scheduled jobs for briefs and consolidation
- Generic MCP support so other clients can call CAL as a capability layer
- Disabled-by-default Auto Heal review for proposal-only repair workflows

## Future Direction

The same architecture can steward other systems by changing the model, tools, and health definition:

- a business or team
- a product lifecycle
- a codebase or engineering system
- a customer success portfolio
- a community or knowledge base

CAL is the first instance of a broader pattern: user-owned continuity for systems that matter.

