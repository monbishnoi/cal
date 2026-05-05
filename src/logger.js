/**
 * Structured Logger for Cal Gateway
 *
 * Two-layer logging:
 * 1. Structured JSON to stderr (→ gateway-error.log) — for local diagnosis
 * 2. Human summary to daily log (→ memory/YYYY-MM-DD.md) — for context
 *
 * No external dependencies. Uses OTel semantic conventions for field names.
 */

import fs from 'fs';
import path from 'path';
import { MEMORY_DIR } from './paths.js';
import { getTimezone, getLocale } from './user-config.js';

const DAILY_LOG_DIR = MEMORY_DIR;

// Callback for sending consent prompt (set by channels)
let consentPromptCallback = null;

/**
 * Set callback for sending consent prompt to user
 */
export function setConsentPromptCallback(callback) {
  consentPromptCallback = callback;
}

/**
 * Log a significant error with structured JSON + daily log entry.
 *
 * @param {string} event - Event type (tool_timeout, session_corruption, max_iterations, etc.)
 * @param {Object} details - Event details
 * @param {string} details.session - Session ID
 * @param {string} [details.tool] - Tool name if applicable
 * @param {string} [details.message] - User message (truncated for privacy)
 * @param {string} [details.error] - Error message
 * @param {string} [details.recovery] - Recovery action taken
 * @param {string} [details.iterations] - Tool iterations (e.g., "5/10")
 * @param {string} [details.percentage] - Context usage percentage
 * @param {string} [details.channel] - Channel (imessage, http, scheduler)
 * @param {string} [details.job] - Job ID if from scheduler
 */
export function logError(event, details = {}) {
  const timestamp = new Date().toISOString();
  const time = new Date().toLocaleTimeString(getLocale(), {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: getTimezone()
  });

  // 1. Structured JSON to stderr (→ gateway-error.log)
  const logEntry = {
    ts: timestamp,
    event,
    session: details.session || 'unknown',
    ...details
  };

  // Remove undefined values for cleaner logs
  Object.keys(logEntry).forEach(key => {
    if (logEntry[key] === undefined) delete logEntry[key];
  });

  console.error(JSON.stringify(logEntry));

  // 2. Human summary to daily log (only for significant events)
  if (shouldWriteToDailyLog(event)) {
    const summary = formatSummary(event, details, time);
    appendToDailyLog(summary);
  }
}

/**
 * Determine if this event warrants a daily log entry.
 * We don't want to spam the daily log with every minor error.
 */
function shouldWriteToDailyLog(event) {
  const significantEvents = [
    'tool_timeout',
    'session_corruption',
    'max_iterations',
    'session_bridge',
    'context_exhausted',
    'job_failed',
    'api_error',
  ];
  return significantEvents.includes(event);
}

/**
 * Format human-readable summary for daily log.
 */
function formatSummary(event, details, time) {
  const { tool, message, recovery, percentage, iterations, job, error } = details;

  let text = `**${time}** — `;

  switch (event) {
    case 'tool_timeout':
      text += `Tool timeout: ${tool || 'unknown'}`;
      break;
    case 'session_corruption':
      text += 'Session corruption detected';
      break;
    case 'max_iterations':
      text += `Hit max iterations (${iterations || '?'})`;
      break;
    case 'session_bridge':
      text += `Session Bridge triggered at ${percentage || '?'}`;
      break;
    case 'context_exhausted':
      text += 'Context limit reached mid-task';
      break;
    case 'job_failed':
      text += `Scheduled job failed: ${job || 'unknown'}`;
      break;
    case 'api_error':
      text += `API error: ${error?.substring(0, 50) || 'unknown'}`;
      break;
    default:
      text += `Error: ${event}`;
  }

  if (message) {
    text += `\n→ While: "${message.substring(0, 60)}..."`;
  }
  if (recovery) {
    text += `\n→ ${recovery}`;
  }

  return text + '\n\n';
}

/**
 * Append entry to daily log's "Cal System Events" section.
 */
function appendToDailyLog(entry) {
  const today = new Date().toISOString().split('T')[0];
  const logPath = path.join(DAILY_LOG_DIR, `${today}.md`);

  try {
    let content = '';
    if (fs.existsSync(logPath)) {
      content = fs.readFileSync(logPath, 'utf-8');
    }

    const sectionHeader = '## Cal System Events';
    if (!content.includes(sectionHeader)) {
      // Add section at the end with a separator
      content += `\n---\n\n${sectionHeader}\n\n`;
    }

    // Append entry to end of file
    content += entry;
    fs.writeFileSync(logPath, content);

  } catch (err) {
    // Use console.log (not console.error) to avoid recursion
    console.log('[Logger] Failed to write daily log:', err.message);
  }
}

/**
 * Log info-level event (no daily log, just structured JSON to stdout).
 * For events we want in logs but aren't errors.
 */
export function logInfo(event, details = {}) {
  const timestamp = new Date().toISOString();

  const logEntry = {
    ts: timestamp,
    event,
    level: 'info',
    session: details.session || 'unknown',
    ...details
  };

  Object.keys(logEntry).forEach(key => {
    if (logEntry[key] === undefined) delete logEntry[key];
  });

  console.log(JSON.stringify(logEntry));
}
