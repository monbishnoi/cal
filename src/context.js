/**
 * Context Loader for Cal Gateway
 *
 * Builds system prompt from CAL.md (identity), STARTUP-MEMORY.md,
 * USER.md (user profile), and today's daily log.
 * Includes Session Bridge restoration for continuity after handoffs.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { CAL_HOME, MEMORY_DIR, DATA_DIR, MEMORY_FILE, STARTUP_MEMORY_FILE, USER_FILE } from './paths.js';
import { getTimezone, getLocale } from './user-config.js';

const DEFAULT_LAST_HANDOFF_PATH = join(DATA_DIR, 'last-handoff.json');
let lastHandoffPath = process.env.CAL_LAST_HANDOFF_PATH || DEFAULT_LAST_HANDOFF_PATH;

export function __setLastHandoffPathForTest(path) {
  lastHandoffPath = path || DEFAULT_LAST_HANDOFF_PATH;
}

/**
 * Load system prompt from Harness directory
 */
export function loadSystemPrompt(sessionId = null) {
  const parts = [];

  // 1. Load CAL.md (Cal's identity/soul)
  const calMdPath = join(CAL_HOME, 'CAL.md');
  if (existsSync(calMdPath)) {
    const calMd = readFileSync(calMdPath, 'utf8');
    parts.push('# Cal\'s Identity (CAL.md)\n\n' + calMd);
  }

  // 2. Load canonical active memory. STARTUP-MEMORY.md is a generated,
  // bounded projection of the durable MEMORY.md/QMD retrieval source.
  // Fall back to a legacy MEMORY.md slice only when the projection is absent.
  if (existsSync(STARTUP_MEMORY_FILE)) {
    const startupMemory = readFileSync(STARTUP_MEMORY_FILE, 'utf8');
    parts.push('\n\n# Startup Memory (STARTUP-MEMORY.md)\n\n' + startupMemory);
  } else if (existsSync(MEMORY_FILE)) {
    const memoryMd = readFileSync(MEMORY_FILE, 'utf8');
    const lines = memoryMd.split('\n').slice(0, 200);
    parts.push('\n\n# Long-Term Memory Fallback (MEMORY.md first 200 lines)\n\n' + lines.join('\n'));
  }

  // 3. Load USER.md (user profile)
  if (existsSync(USER_FILE)) {
    const userMd = readFileSync(USER_FILE, 'utf8');
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
  const restorationContext = getRestorationContextFromFile(sessionId);
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
function getRestorationContextFromFile(sessionId = null) {
  try {
    if (!existsSync(lastHandoffPath)) {
      return null;
    }

    const handoffData = normalizeHandoffData(JSON.parse(readFileSync(lastHandoffPath, 'utf8')));

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

    const context = formatRestorationContext(handoffData, sessionId, handoffTime);

    return context || null;

  } catch (err) {
    console.error(`[Context] Failed to load handoff data:`, err.message);
    return null;
  }
}

function normalizeHandoffData(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.sessions && typeof raw.sessions === 'object') {
    return {
      timestamp: raw.timestamp || new Date().toISOString(),
      sessions: raw.sessions,
      slimContext: raw.slimContext || {},
    };
  }

  const timestamp = raw.timestamp || new Date().toISOString();
  return {
    timestamp,
    sessions: {
      home: {
        sessionId: raw.sessionId || 'home',
        name: 'Cal',
        activeTask: {
          description: raw.summary || 'Previous Cal session',
          workstream: null,
          status: 'handoff',
          currentStep: 'Resume from the saved handoff summary.',
          completedSteps: [],
          nextSteps: [],
          blockers: [],
        },
        summary: raw.summary || null,
        lastActive: timestamp,
        closed: false,
      },
    },
    slimContext: raw.slimContext || {},
  };
}

function getSessionBridgeKey(sessionId) {
  const id = String(sessionId || '').trim();
  return id.startsWith('strand-') ? id : 'home';
}

function formatRestorationContext(handoffData, sessionId, handoffTime) {
  const sessions = handoffData.sessions || {};
  const ownKey = getSessionBridgeKey(sessionId);
  const ownEntry = sessions[ownKey] || null;
  const otherEntries = Object.entries(sessions)
    .filter(([key]) => key !== ownKey)
    .map(([key, entry]) => ({ key, entry }))
    .filter(({ entry }) => entry && typeof entry === 'object');

  if (!ownEntry && otherEntries.length === 0) {
    return null;
  }

  const sections = [
    '# Session Bridge — Active Context',
    '',
    `**Last updated:** ${handoffTime.toLocaleString(getLocale(), { timeZone: getTimezone() })}`,
  ];

  if (ownEntry) {
    sections.push('', '## Your Active Context', formatSessionEntry(ownEntry, { detailed: true }));
  }

  if (otherEntries.length > 0) {
    sections.push('', '## Other Sessions');
    for (const { key, entry } of otherEntries) {
      sections.push(`- ${formatSessionEntrySummary(key, entry)}`);
    }
  }

  const slim = handoffData.slimContext || {};
  const decisions = Array.isArray(slim.keyDecisions) ? slim.keyDecisions.filter(Boolean) : [];
  const artifacts = Array.isArray(slim.artifactsInProgress) ? slim.artifactsInProgress.filter(Boolean) : [];
  const questions = Array.isArray(slim.openQuestions) ? slim.openQuestions.filter(Boolean) : [];

  if (decisions.length || artifacts.length || questions.length) {
    sections.push('', '## Shared Slim Context');
    if (decisions.length) sections.push(`Key decisions: ${decisions.join('; ')}`);
    if (artifacts.length) sections.push(`Artifacts in progress: ${artifacts.join('; ')}`);
    if (questions.length) sections.push(`Open questions: ${questions.join('; ')}`);
  }

  return sections.join('\n');
}

function formatSessionEntry(entry, { detailed = false } = {}) {
  const task = entry.activeTask || {};
  const lines = [
    `Session: ${entry.name || entry.sessionId || 'Cal'}${entry.closed ? ' (closed)' : ''}`,
    `Description: ${task.description || entry.summary || 'No active task captured.'}`,
    `Status: ${task.status || (entry.closed ? 'closed' : 'ready')}`,
  ];

  if (task.workstream) lines.push(`Workstream: ${task.workstream}`);
  if (task.currentStep) lines.push(`Current step: ${task.currentStep}`);
  if (task.savedAt) lines.push(`Saved at: ${task.savedAt}`);
  if (detailed && Array.isArray(task.completedSteps) && task.completedSteps.length) {
    lines.push(`Completed: ${task.completedSteps.join('; ')}`);
  }
  if (detailed && Array.isArray(task.remainingSteps) && task.remainingSteps.length) {
    lines.push(`Remaining: ${task.remainingSteps.join('; ')}`);
  }
  if (detailed && Array.isArray(task.failedSteps) && task.failedSteps.length) {
    lines.push(`Failed but unresolved: ${task.failedSteps.join('; ')}`);
  }
  if (detailed && Array.isArray(task.nextSteps) && task.nextSteps.length) {
    lines.push(`Next: ${task.nextSteps.join('; ')}`);
  }
  if (detailed && Array.isArray(task.blockers) && task.blockers.length) {
    lines.push(`Blockers: ${task.blockers.join('; ')}`);
  }
  if (entry.summary) lines.push(`Summary: ${entry.summary}`);

  return lines.join('\n');
}

function formatSessionEntrySummary(key, entry) {
  const task = entry.activeTask || {};
  const name = entry.name || (key === 'home' ? 'Cal' : key);
  const description = task.description || entry.summary || 'No active task captured.';
  const status = task.status || (entry.closed ? 'closed' : 'ready');
  return `${name}${entry.closed ? ' (closed)' : ''}: ${description} [${status}]`;
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
