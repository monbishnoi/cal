/**
 * Context Loader for Cal Gateway
 *
 * Builds system prompt from CAL.md (identity), MEMORY.md (long-term memory),
 * USER.md (user profile), and today's daily log.
 * Includes Session Bridge restoration for continuity after handoffs.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { CAL_HOME, MEMORY_DIR, CONTEXT_DIR, DATA_DIR } from './paths.js';
import { getTimezone, getLocale } from './user-config.js';

const LAST_HANDOFF_PATH = join(DATA_DIR, 'last-handoff.json');

/**
 * Load system prompt from Harness directory
 */
export function loadSystemPrompt() {
  const parts = [];

  // 1. Load CAL.md (Cal's identity/soul)
  const calMdPath = join(CAL_HOME, 'CAL.md');
  if (existsSync(calMdPath)) {
    const calMd = readFileSync(calMdPath, 'utf8');
    parts.push('# Cal\'s Identity (CAL.md)\n\n' + calMd);
  }

  // 2. Load MEMORY.md (long-term memory) - first 200 lines only
  const memoryMdPath = join(CONTEXT_DIR, 'MEMORY.md');
  if (existsSync(memoryMdPath)) {
    const memoryMd = readFileSync(memoryMdPath, 'utf8');
    const lines = memoryMd.split('\n').slice(0, 200);
    parts.push('\n\n# Long-Term Memory (MEMORY.md)\n\n' + lines.join('\n'));
  }

  // 3. Load USER.md (user profile)
  const userMdPath = join(CONTEXT_DIR, 'USER.md');
  if (existsSync(userMdPath)) {
    const userMd = readFileSync(userMdPath, 'utf8');
    parts.push('\n\n# User Profile (USER.md)\n\n' + userMd);
  }

  // 4. Load today's daily log if exists
  const today = getToday();
  const dailyLogPath = join(MEMORY_DIR, `${today}.md`);
  if (existsSync(dailyLogPath)) {
    const dailyLog = readFileSync(dailyLogPath, 'utf8');
    parts.push('\n\n# Today\'s Log (' + today + ')\n\n' + dailyLog);
  }

  // 5. Session Bridge: Load restoration context if recent handoff exists
  const restorationContext = getRestorationContextFromFile();
  if (restorationContext) {
    parts.push('\n\n' + restorationContext);
  }

  const systemPrompt = parts.join('\n');
  console.log(`[Context] Loaded system prompt: ${systemPrompt.length} chars`);

  return systemPrompt;
}

/**
 * Get Session Bridge restoration context from last handoff
 * Returns context if handoff is recent (within 24 hours)
 *
 * Simplified: Just timestamp + summary, no delta or continuation prompt
 */
function getRestorationContextFromFile() {
  try {
    if (!existsSync(LAST_HANDOFF_PATH)) {
      return null;
    }

    const handoffData = JSON.parse(readFileSync(LAST_HANDOFF_PATH, 'utf8'));

    if (!handoffData || !handoffData.timestamp) {
      return null;
    }

    // Check if handoff is recent (within 24 hours)
    const handoffTime = new Date(handoffData.timestamp);
    const hoursSinceHandoff = (Date.now() - handoffTime.getTime()) / (1000 * 60 * 60);

    if (hoursSinceHandoff > 24) {
      console.log(`[Context] Handoff data is ${hoursSinceHandoff.toFixed(1)} hours old, not restoring`);
      return null;
    }

    console.log(`[Context] Session Bridge: Restoring context from handoff ${hoursSinceHandoff.toFixed(1)} hours ago`);

    // Simple restoration context - just where we left off
    const context = `# Session Bridge — Continuing from Previous Session

**Last session ended:** ${handoffTime.toLocaleString(getLocale(), { timeZone: getTimezone() })}

## Where We Left Off
${handoffData.summary || 'No summary available'}
`;

    return context;

  } catch (err) {
    console.error(`[Context] Failed to load handoff data:`, err.message);
    return null;
  }
}

/**
 * Get current date in YYYY-MM-DD format (user's timezone)
 */
export function getToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: getTimezone() });
}

/**
 * Get current date/time context string
 */
export function getCurrentTimeContext() {
  const timezone = getTimezone();
  const locale = getLocale();
  const now = new Date();
  const dateStr = now.toLocaleDateString(locale, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: timezone
  });
  const timeStr = now.toLocaleTimeString(locale, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: timezone
  });

  return `**${dateStr}** at **${timeStr}**`;
}
