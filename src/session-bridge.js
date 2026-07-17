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

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { getToday } from './context.js';
import { logError } from './logger.js';
import { DATA_DIR } from './paths.js';

const DEFAULT_LAST_HANDOFF_PATH = join(DATA_DIR, 'last-handoff.json');
let lastHandoffPath = process.env.CAL_LAST_HANDOFF_PATH || DEFAULT_LAST_HANDOFF_PATH;

export function getLastHandoffPath() {
  return lastHandoffPath;
}

export function __setLastHandoffPathForTest(path) {
  lastHandoffPath = path || DEFAULT_LAST_HANDOFF_PATH;
}

/**
 * Perform handoff within the main session
 *
 * Cal sees the ENTIRE conversation and can summarize properly.
 * After handoff completes, the session should be reset.
 *
 * @param {Object} mainSession - The main CalSession
 * @returns {Promise<{success: boolean, summary: string}>} - Handoff result
 */
export async function performInSessionHandoff(mainSession, options = {}) {
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
     "timestamp": "${timestamp}",
     "sessions": {
       "home": {
         "sessionId": "${mainSession.sessionId}",
         "activeTask": {
           "description": "What this session is actively working on",
           "workstream": "cal-gateway",
           "status": "handoff",
           "currentStep": "Context handoff at 90%",
           "completedSteps": ["Important completed steps"],
           "remainingSteps": ["Unexecuted steps still required for end-to-end completion"],
           "nextSteps": ["Immediate next step"],
           "failedSteps": ["Attempted steps that failed and still need resolution"],
           "blockers": [],
           "continueAfterBridge": true,
           "savedAt": "${timestamp}"
         },
         "summary": "Your summary here",
         "lastActive": "${timestamp}",
         "closed": false
       }
     },
     "slimContext": {
       "keyDecisions": ["Important decisions"],
       "artifactsInProgress": ["Important file paths"],
       "openQuestions": []
     }
   }
   \`\`\`

   Treat \`activeTask\` as a remaining-work ledger. Put already executed work in \`completedSteps\`. Put only unexecuted work still required for end-to-end completion in \`remainingSteps\`. Put failed attempts that still need resolution in \`failedSteps\` and keep the needed resolution in \`remainingSteps\` or \`blockers\`. Set \`continueAfterBridge\` to \`true\` only when \`remainingSteps\` contains work that should continue after reset; otherwise set it to \`false\`.

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

Do not tell the user anything. The gateway will show the bridge status and continue any remaining active task after reset.

Do the handoff now.`;

  try {
    // Mark handoff as triggered
    mainSession.handoffTriggered = true;
    mainSession.persistToDisk();

    // Send handoff prompt to the SAME session (Cal sees everything)
    const result = await mainSession.sendMessage(handoffPrompt, {
      internal: options.internal === true,
      isHandoff: true,
      maxIterations: 8,
    });

    console.log(`[SessionBridge] Handoff completed, response length: ${result.text.length}`);

    // Extract summary from what Cal wrote (best effort)
    const summary = extractSummaryFromResponse(result.text);
    const entry = writeActiveContext(mainSession, {
      summary,
      status: 'handoff_complete',
      currentStep: 'Session context was saved at the bridge threshold.',
      reason: 'session_bridge',
    });

    return {
      success: true,
      summary,
      activeTask: entry.activeTask,
      entry,
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

export function getSessionBridgeKey(sessionId, options = {}) {
  if (options.key) return options.key;
  if (options.home || options.permanent) return 'home';

  const id = String(sessionId || '').trim();
  if (!id) return 'home';
  return id.startsWith('strand-') ? id : 'home';
}

export function writeActiveContext(sessionOrRecord, options = {}) {
  const record = sessionOrRecord?.runtime ? sessionOrRecord : null;
  const session = record?.runtime || sessionOrRecord;
  const sessionId = session?.sessionId || record?.sessionId || options.sessionId;
  const key = getSessionBridgeKey(sessionId, {
    key: options.key,
    home: options.home,
    permanent: options.permanent ?? record?.permanent,
  });
  const timestamp = options.timestamp || new Date().toISOString();
  const data = loadHandoffData() || emptyHandoffData(timestamp);
  const previous = data.sessions?.[key] || {};
  const closed = options.closed === true;

  data.timestamp = timestamp;
  data.sessions = data.sessions || {};
  data.sessions[key] = {
    ...previous,
    name: options.name || record?.name || previous.name || (key === 'home' ? 'Cal' : 'Strand'),
    sessionId: sessionId || previous.sessionId || key,
    activeTask: closed
      ? null
      : buildActiveTask(session, previous.activeTask, options),
    summary: options.summary ?? previous.summary ?? null,
    lastActive: timestamp,
    closed: closed ? true : options.closed === false ? false : !!previous.closed && key !== 'home',
  };

  if (closed) {
    data.sessions[key].closedAt = timestamp;
  } else {
    delete data.sessions[key].closedAt;
  }

  data.slimContext = mergeSlimContext(data.slimContext, options.slimContext);
  saveHandoffData(data);
  return data.sessions[key];
}

export function writeActiveContextsForSessions(sessionsOrRecords = [], options = {}) {
  const written = [];
  const seen = new Set();

  for (const item of sessionsOrRecords) {
    const session = item?.runtime || item;
    const sessionId = session?.sessionId || item?.sessionId;
    const key = getSessionBridgeKey(sessionId, {
      permanent: item?.permanent,
      home: options.homeSessionId && sessionId === options.homeSessionId,
    });
    if (seen.has(key)) continue;
    seen.add(key);

    written.push(writeActiveContext(item, {
      ...options,
      key,
      name: item?.name,
      permanent: item?.permanent,
      closed: false,
    }));
  }

  return written;
}

export function getActiveTaskForSession(sessionId) {
  const data = loadHandoffData();
  if (!data?.sessions) return null;
  const key = getSessionBridgeKey(sessionId);
  return data.sessions[key]?.activeTask || null;
}

export function shouldContinueActiveTask(activeTask) {
  if (!activeTask || typeof activeTask !== 'object') return false;
  if (activeTask.continueAfterBridge !== true) return false;

  const status = String(activeTask.status || '').toLowerCase();
  if (['complete', 'completed', 'done', 'blocked', 'closed'].includes(status)) {
    return false;
  }

  const remaining = activeTask.remainingSteps?.length
    ? activeTask.remainingSteps
    : activeTask.nextSteps || [];
  return remaining.length > 0 || !!activeTask.currentStep;
}

export function buildContinuationPrompt(activeTask) {
  const remaining = activeTask.remainingSteps?.length
    ? activeTask.remainingSteps
    : activeTask.nextSteps || [];

  return [
    '[SYSTEM: Session Bridge continuation]',
    '',
    'Continue the saved active task for this session.',
    'Execute only work that is still remaining. Do not repeat completed steps.',
    'If an attempted step failed but is still required, keep it in remaining work or blockers and continue resolving it.',
    '',
    'Active task:',
    JSON.stringify({
      description: activeTask.description,
      workstream: activeTask.workstream,
      status: activeTask.status,
      currentStep: activeTask.currentStep,
      completedSteps: activeTask.completedSteps || [],
      remainingSteps: remaining,
      failedSteps: activeTask.failedSteps || [],
      blockers: activeTask.blockers || [],
    }, null, 2),
  ].join('\n');
}

export async function resetAndContinueAfterBridge(session, activeTask = null, options = {}) {
  const task = activeTask || getActiveTaskForSession(session?.sessionId);

  session.reset();
  session.isInitialized = false;
  if (typeof session.initialize === 'function') {
    await session.initialize();
  }

  if (!shouldContinueActiveTask(task)) {
    return {
      continued: false,
      text: '',
      usageStatus: session.getUsageStatus?.() || null,
    };
  }

  const result = await session.sendMessage(buildContinuationPrompt(task), {
    internal: options.internal === true,
    isBridgeContinuation: true,
    maxIterations: options.maxIterations || 10,
  });

  return {
    continued: true,
    text: result.text || '',
    usageStatus: result.usageStatus || null,
  };
}

/**
 * Load handoff data from disk
 * Used by context.js for session restoration
 */
export function loadHandoffData() {
  try {
    if (!existsSync(lastHandoffPath)) {
      return null;
    }
    return normalizeHandoffData(JSON.parse(readFileSync(lastHandoffPath, 'utf8')));
  } catch (err) {
    console.error(`[SessionBridge] Failed to load handoff data:`, err.message);
    return null;
  }
}

function emptyHandoffData(timestamp) {
  return {
    timestamp,
    sessions: {},
    slimContext: {
      keyDecisions: [],
      artifactsInProgress: [],
      openQuestions: [],
    },
  };
}

function normalizeHandoffData(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.sessions && typeof raw.sessions === 'object') {
    return {
      timestamp: raw.timestamp || new Date().toISOString(),
      sessions: raw.sessions,
      slimContext: normalizeSlimContext(raw.slimContext),
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
    slimContext: normalizeSlimContext(raw.slimContext),
  };
}

function normalizeSlimContext(value) {
  return {
    keyDecisions: Array.isArray(value?.keyDecisions) ? value.keyDecisions : [],
    artifactsInProgress: Array.isArray(value?.artifactsInProgress) ? value.artifactsInProgress : [],
    openQuestions: Array.isArray(value?.openQuestions) ? value.openQuestions : [],
  };
}

function mergeSlimContext(existing, incoming) {
  const base = normalizeSlimContext(existing);
  const next = normalizeSlimContext(incoming);
  return {
    keyDecisions: uniqueStrings([...base.keyDecisions, ...next.keyDecisions]),
    artifactsInProgress: uniqueStrings([...base.artifactsInProgress, ...next.artifactsInProgress]),
    openQuestions: uniqueStrings([...base.openQuestions, ...next.openQuestions]),
  };
}

function uniqueStrings(values) {
  return values
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index);
}

function saveHandoffData(data) {
  mkdirSync(dirname(lastHandoffPath), { recursive: true });
  writeFileSync(lastHandoffPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function buildActiveTask(session, previousTask, options) {
  const latestUser = latestTextMessage(session, 'user');
  const latestAssistant = latestTextMessage(session, 'assistant');

  if (options.activeTask) {
    return normalizeActiveTask({
      ...(previousTask || {}),
      ...options.activeTask,
      description: options.activeTask.description ||
        options.description ||
        summarizeText(latestUser) ||
        previousTask?.description,
      currentStep: options.activeTask.currentStep ||
        options.currentStep ||
        summarizeText(latestAssistant) ||
        previousTask?.currentStep,
    });
  }

  const description = options.description ||
    summarizeText(latestUser) ||
    previousTask?.description ||
    'No active task captured yet';

  return normalizeActiveTask({
    description,
    workstream: options.workstream ?? previousTask?.workstream ?? inferWorkstream(latestUser),
    status: options.status || (session?.isProcessingMessage ? 'working' : previousTask?.status || 'ready'),
    currentStep: options.currentStep ||
      summarizeText(latestAssistant) ||
      previousTask?.currentStep ||
      'Awaiting the next user message.',
    completedSteps: options.completedSteps || previousTask?.completedSteps || [],
    remainingSteps: options.remainingSteps || previousTask?.remainingSteps || previousTask?.nextSteps || [],
    nextSteps: options.nextSteps || previousTask?.nextSteps || [],
    failedSteps: options.failedSteps || previousTask?.failedSteps || [],
    blockers: options.blockers || previousTask?.blockers || [],
    continueAfterBridge: options.continueAfterBridge ?? previousTask?.continueAfterBridge ?? false,
    savedAt: options.savedAt || new Date().toISOString(),
  });
}

function normalizeActiveTask(task) {
  const completedSteps = Array.isArray(task?.completedSteps) ? task.completedSteps : [];
  const nextSteps = Array.isArray(task?.nextSteps) ? task.nextSteps : [];
  const remainingSteps = Array.isArray(task?.remainingSteps) ? task.remainingSteps : nextSteps;

  return {
    description: String(task?.description || 'No active task captured yet'),
    workstream: task?.workstream || null,
    status: String(task?.status || 'ready'),
    currentStep: String(task?.currentStep || 'Awaiting the next user message.'),
    completedSteps,
    remainingSteps,
    nextSteps,
    failedSteps: Array.isArray(task?.failedSteps) ? task.failedSteps : [],
    blockers: Array.isArray(task?.blockers) ? task.blockers : [],
    continueAfterBridge: task?.continueAfterBridge === true,
    savedAt: task?.savedAt || new Date().toISOString(),
  };
}

function latestTextMessage(session, role) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (role && message.role !== role) continue;
    const text = textFromContent(message.displayContent || message.content).trim();
    if (text && !text.startsWith('[SYSTEM:')) {
      return stripRuntimeContext(text);
    }
  }
  return '';
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => {
      if (part?.type === 'text') return part.text || '';
      if (part?.type === 'tool_result') return textFromContent(part.content);
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function stripRuntimeContext(text) {
  return String(text || '')
    .replace(/^\*\*[^*]+\*\* at \*\*[^*]+\*\*\n\n/, '')
    .replace(/^\[SYSTEM: Relevant skill context[\s\S]*?\[END RELEVANT SKILL CONTEXT\]\n*/m, '')
    .trim();
}

function summarizeText(text, limit = 180) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > limit ? `${normalized.slice(0, limit - 3)}...` : normalized;
}

function inferWorkstream(text) {
  const normalized = String(text || '').toLowerCase();
  if (normalized.includes('cal') || normalized.includes('gateway') || normalized.includes('session bridge')) {
    return 'cal-gateway';
  }
  return null;
}
