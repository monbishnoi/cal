/**
 * Session Bridge - Automatic context preservation for Cal Gateway
 *
 * Handles:
 * - In-session handoff at 90% context usage (Cal sees entire conversation)
 * - Automatic session reset after handoff
 * - Session restoration from handoff data
 *
 * Simplified design (April 2026):
 * - No more spawned handoff agent (was losing context)
 * - No more delta capture (session resets at 90%, never reaches 95%)
 * - Handoff happens in main session, then auto-resets
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getToday } from './context.js';
import { logError } from './logger.js';
import { CAL_HOME, DATA_DIR } from './paths.js';

const LAST_HANDOFF_PATH = join(DATA_DIR, 'last-handoff.json');

/**
 * Perform handoff within the main session
 *
 * Cal sees the ENTIRE conversation and can summarize properly.
 * After handoff completes, the session should be reset.
 *
 * @param {Object} mainSession - The main CalSession
 * @returns {Promise<{success: boolean, summary: string}>} - Handoff result
 */
export async function performInSessionHandoff(mainSession) {
  console.log(`[SessionBridge] Performing in-session handoff for ${mainSession.sessionId}`);

  const today = getToday();
  const timestamp = new Date().toISOString();

  // Handoff prompt - Cal sees everything and summarizes
  const handoffPrompt = `[SYSTEM: Context window at 90%. Perform handoff now.]

You are performing an automatic handoff to preserve this conversation before the context limit.

## Your Task

1. **Summarize this entire conversation** — all topics, decisions, and work done
2. **Write to daily log** — append summary to \`memory/${today}.md\`
3. **Update long-term memory** — add any persistent facts to \`context/MEMORY.md\` (if needed)
4. **Save handoff file** — write summary to \`cal-gateway/data/last-handoff.json\` in this format:
   \`\`\`json
   {
     "sessionId": "${mainSession.sessionId}",
     "timestamp": "${timestamp}",
     "summary": "Your summary here"
   }
   \`\`\`

## Daily Log Format

Append this to the daily log:

\`\`\`
## Session Handoff — [current time]

### What We Worked On
[Main topics and tasks]

### Key Decisions Made
- [Decision 1]
- [Decision 2]

### Artifacts Created/Modified
- [File paths and what changed]

### Where We Left Off
[What was in progress, next steps]
\`\`\`

## After completing the handoff:

Tell the user briefly: "Saved our session. Continuing..." — then the session will reset automatically.

Do the handoff now.`;

  try {
    // Mark handoff as triggered
    mainSession.handoffTriggered = true;
    mainSession.persistToDisk();

    // Send handoff prompt to the SAME session (Cal sees everything)
    const result = await mainSession.sendMessage(handoffPrompt);

    console.log(`[SessionBridge] Handoff completed, response length: ${result.text.length}`);

    // Extract summary from what Cal wrote (best effort)
    const summary = extractSummaryFromResponse(result.text);

    return {
      success: true,
      summary,
    };

  } catch (err) {
    console.error(`[SessionBridge] In-session handoff failed:`, err.message);

    // Emergency: Save what we can
    emergencySnapshot(mainSession, 'handoff_failure');

    return {
      success: false,
      summary: 'Handoff failed - emergency snapshot saved',
    };
  }
}

/**
 * Extract summary from Cal's handoff response
 * Best effort - looks for common patterns
 */
function extractSummaryFromResponse(text) {
  // Look for "What We Worked On" or similar sections
  const patterns = [
    /what we worked on[:\s]*(.+?)(?=###|$)/is,
    /summary[:\s]*(.+?)(?=###|$)/is,
    /worked on[:\s]*(.+?)(?=\n\n|$)/is,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1].trim().substring(0, 500);
    }
  }

  // Fallback: first substantial paragraph
  const paragraphs = text.split('\n\n').filter(p => p.trim().length > 50);
  return paragraphs[0]?.substring(0, 500) || 'Session handoff completed';
}

/**
 * Emergency snapshot - fallback when handoff fails
 * Saves minimal context to ensure nothing is completely lost
 *
 * @param {Object} mainSession - The session to snapshot
 * @param {string} reason - Why we're doing emergency snapshot
 * @returns {boolean} - Whether snapshot succeeded
 */
export function emergencySnapshot(mainSession, reason) {
  console.log(`[SessionBridge] Emergency snapshot (reason: ${reason})`);

  try {
    const timestamp = Date.now();

    // Save raw snapshot to data/
    const snapshotPath = join(DATA_DIR, `emergency-snapshot-${timestamp}.json`);
    writeFileSync(snapshotPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      reason,
      sessionId: mainSession.sessionId,
      messageCount: mainSession.messages.length,
      tokenUsage: mainSession.tokenUsage,
      // Save last 10 messages as context
      recentMessages: mainSession.messages.slice(-10).map(msg => ({
        role: msg.role,
        content: typeof msg.content === 'string'
          ? msg.content.substring(0, 500)
          : '[tool use]',
      })),
    }, null, 2));

    console.log(`[SessionBridge] Emergency snapshot saved to ${snapshotPath}`);
    return true;

  } catch (err) {
    console.error(`[SessionBridge] Emergency snapshot failed:`, err.message);
    return false;
  }
}

/**
 * Load handoff data from disk
 * Used by context.js for session restoration
 */
export function loadHandoffData() {
  try {
    if (!existsSync(LAST_HANDOFF_PATH)) {
      return null;
    }
    return JSON.parse(readFileSync(LAST_HANDOFF_PATH, 'utf8'));
  } catch (err) {
    console.error(`[SessionBridge] Failed to load handoff data:`, err.message);
    return null;
  }
}
