#!/usr/bin/env node

import './env.js';

/**
 * Cal Gateway
 *
 * Unified daemon for Cal — handles scheduled jobs, interactive channels,
 * and tool execution with shared session context.
 */

import { initSessionStore, flushToDisk } from './session-store.js';
import { CalSession } from './session.js';
import { initScheduler, stopScheduler, triggerJob, getJobStatus, loadJobs } from './scheduler.js';
import { startIMessage, stopIMessage, sendMessage as sendIMessage, setSession as setIMessageSession } from './imessage.js';
import { startHttpServer, stopHttpServer, getHttpPort, getHttpHost, setSession as setHttpSession } from './http-server.js';
import { routeOutput } from './output.js';
import { loadSkills, getSkillNames } from './skills.js';
import { initMCPClients, getMCPClientManager } from './mcp-client.js';
import { performInSessionHandoff } from './session-bridge.js';
import { logError, logInfo } from './logger.js';
import { CAL_HOME } from './paths.js';
import { getMainSessionId, getBackgroundSessionId, getTimezone } from './user-config.js';
import { filterRuntimeMCPServers } from './runtime-config.js';

let startTelegram = null;
let stopTelegram = null;
let sendTelegram = null;
let setTelegramSession = null;
let telegramAvailable = false;

try {
  const telegram = await import('./telegram.js');
  startTelegram = telegram.startTelegram;
  stopTelegram = telegram.stopTelegram;
  sendTelegram = telegram.sendMessage;
  setTelegramSession = telegram.setSession;
  telegramAvailable = true;
} catch (err) {
  console.log(`[Gateway] Telegram module not available: ${err.message}`);
}

// Gateway version
const VERSION = '0.4.0';

// Session IDs (from user config)
const MAIN_SESSION_ID = getMainSessionId();
const BACKGROUND_SESSION_ID = getBackgroundSessionId();

// Sessions (owned by gateway, shared with channels)
let mainSession = null;
let backgroundSession = null;

// Telegram/iMessage enabled flags (set during startup)
let telegramEnabled = false;

// iMessage enabled flag (set during startup)
let imessageEnabled = false;

/**
 * Get or create the main session (shared across all channels)
 */
function getMainSession() {
  if (!mainSession) {
    mainSession = new CalSession(MAIN_SESSION_ID);
  }
  return mainSession;
}

/**
 * Send notification via iMessage (if enabled)
 */
async function sendNotification(message) {
  if (telegramEnabled && sendTelegram) {
    return await sendTelegram(message);
  } else if (imessageEnabled) {
    return await sendIMessage(message);
  } else {
    console.log('[Gateway] No notification channel available');
    return false;
  }
}

/**
 * Get or create background session for non-interactive jobs
 */
function getBackgroundSession() {
  if (!backgroundSession) {
    backgroundSession = new CalSession(BACKGROUND_SESSION_ID);
  }
  return backgroundSession;
}

const NEWS_DIGEST_MARKER = /(?:^|\n)(?:\*\*)?(?:📡|📰)\s*(?:AI\s+)?News Digest\s+[—-]/u;

function normalizeMessageText(value) {
  return String(value || '').trim();
}

function extractBashHeredocs(command) {
  if (!command || typeof command !== 'string') {
    return [];
  }

  const heredocs = [];
  const heredocPattern = /<<\s*['"]?([A-Za-z0-9_-]+)['"]?[^\n]*\n([\s\S]*?)\n\1(?:\n|$)/g;
  let match;

  while ((match = heredocPattern.exec(command)) !== null) {
    heredocs.push(match[2]);
  }

  return heredocs;
}

function extractDigestBlock(text) {
  const source = normalizeMessageText(text);
  const match = NEWS_DIGEST_MARKER.exec(source);

  if (!match) {
    return null;
  }

  return source.slice(match.index).trim();
}

function scoreDigestCandidate(text, index) {
  const normalized = normalizeMessageText(text);
  let score = Math.min(normalized.length, 20000);

  if (NEWS_DIGEST_MARKER.test(normalized.split('\n').slice(0, 2).join('\n'))) {
    score += 10000;
  }
  if (normalized.includes('Why it matters')) {
    score += 2000;
  }
  if (normalized.includes('━━━━━━━━')) {
    score += 1000;
  }
  if (/(?:AI\s+)?News Digest for .+ complete/i.test(normalized)) {
    score -= 10000;
  }

  return score + index;
}

function findDeliveryDigest(messages) {
  const candidates = [];

  for (const msg of messages) {
    const parts = Array.isArray(msg.content)
      ? msg.content
      : [{ type: 'text', text: msg.content }];

    for (const part of parts) {
      if (part?.type === 'text' && part.text) {
        candidates.push(part.text);
      }

      if (part?.type === 'tool_result' && part.content) {
        candidates.push(part.content);
      }

      if (part?.type === 'tool_use' && part.input) {
        if (part.input.content) {
          candidates.push(part.input.content);
        }
        if (part.input.new_text) {
          candidates.push(part.input.new_text);
        }
        if (part.input.command) {
          candidates.push(...extractBashHeredocs(part.input.command));
        }
      }
    }
  }

  return candidates
    .map((candidate, index) => ({ text: extractDigestBlock(candidate), index }))
    .filter(candidate => candidate.text)
    .sort((a, b) => scoreDigestCandidate(b.text, b.index) - scoreDigestCandidate(a.text, a.index))[0]?.text || null;
}

function getJobDeliveryResponse(job, response, session, messageStartIndex) {
  const isNewsDigest = /news-digest/i.test(job.id || '') || /news digest/i.test(job.name || '');

  if (!isNewsDigest) {
    return response;
  }

  const digest = findDeliveryDigest(session.messages.slice(messageStartIndex));

  if (!digest) {
    console.warn('[Gateway] News Digest delivery marker not found; falling back to final response');
    return response;
  }

  if (normalizeMessageText(digest) !== normalizeMessageText(response)) {
    console.log('[Gateway] News Digest delivery: using formatted digest block instead of final job summary');
  }

  return digest;
}

/**
 * Job executor - called when a scheduled job fires
 * Uses shared session for interactive jobs, separate session for background jobs
 */
async function executeJob(job) {
  console.log(`\n[Gateway] ════════════════════════════════════════`);
  console.log(`[Gateway] Executing job: ${job.id}`);
  console.log(`[Gateway] Prompt: ${job.prompt.substring(0, 80)}...`);

  // Determine which session to use
  const isBackgroundJob = job.sessionType === 'background';
  const session = isBackgroundJob ? getBackgroundSession() : getMainSession();

  if (isBackgroundJob) {
    console.log(`[Gateway] Using background session (isolated from interactive)`);
  }

  try {
    // Add job context to the prompt
    const jobPrompt = `[Scheduled Job: ${job.name}]\n\n${job.prompt}`;
    const messageStartIndex = session.messages.length;

    // Execute via CalSession with job-specific maxIterations
    const result = await session.sendMessage(jobPrompt, {
      onToolCall: (name, input) => {
        console.log(`[Gateway] Tool: ${name}`);
      },
      maxIterations: job.maxIterations || 20,  // Default 20 for jobs
      isBackgroundJob: isBackgroundJob,
    });

    // Session Bridge: Check if handoff needed (only for main session)
    let response = result.text;
    const usage = result.usageStatus;

    if (!isBackgroundJob && usage.thresholdHandoff && !usage.handoffTriggered) {
      console.log(`[Gateway] Session Bridge: 90% threshold reached during job ${job.id}, performing in-session handoff`);
      await performInSessionHandoff(session);
      session.reset();
      console.log(`[Gateway] Session Bridge: Session reset after handoff`);
      response += '\n\n---\nSession saved and refreshed.';
    }

    const deliveryResponse = getJobDeliveryResponse(job, response, session, messageStartIndex);

    // Route output to appropriate destination
    await routeOutput(job, deliveryResponse);

    console.log(`[Gateway] Job complete: ${job.id}`);
    console.log(`[Gateway] ════════════════════════════════════════\n`);

    return deliveryResponse;
  } catch (err) {
    console.error(`[Gateway] Job failed:`, err.message);

    // Send error notification
    await sendNotification(`*Cal Gateway Error*\n\nJob: ${job.name}\nError: ${err.message}`);

    throw err;
  }
}

/**
 * Start the gateway daemon
 */
async function start() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                    CAL GATEWAY v${VERSION}                        ║
║                       Unified Daemon                          ║
╚══════════════════════════════════════════════════════════════╝
`);

  const timezone = getTimezone();
  const startTime = new Date().toLocaleString('en-US', { timeZone: timezone });
  console.log(`[Gateway] Starting at ${startTime}`);

  // 1. Initialize session store (load persisted sessions from disk)
  console.log('[Gateway] Initializing session store...');
  initSessionStore();

  // 2. Load skills
  console.log('[Gateway] Loading skills...');
  const skills = loadSkills();

  // 3. Initialize shared session (owned by gateway, shared with channels)
  console.log('[Gateway] Creating shared session...');
  const session = getMainSession();
  console.log(`[Gateway] Session: ${session.sessionId} (${session.messages.length} messages)`);

  // Pass session to channels
  if (telegramAvailable && setTelegramSession) {
    setTelegramSession(session);
  }
  setIMessageSession(session);
  setHttpSession(session);

  // 4. Initialize MCP clients (connect to configured MCP servers like QMD)
  console.log('[Gateway] Connecting to MCP servers...');
  const config = loadJobs();
  const mcpConfig = filterRuntimeMCPServers(config.mcpServers || {});

  // Build auth providers for servers that need OAuth.
  // Public distribution does not ship provider-specific OAuth handlers by default.
  const authProviders = {};

  await initMCPClients(mcpConfig, authProviders);

  // 5. Initialize scheduler
  console.log('[Gateway] Starting scheduler...');
  initScheduler(executeJob);

  // 6. Start HTTP server (local/PWA endpoint)
  console.log('[Gateway] Starting HTTP server...');
  try {
    await startHttpServer();
  } catch (err) {
    console.error('[Gateway] Failed to start HTTP server:', err.message);
    console.error('[Gateway] Continuing without HTTP server');
  }

  // 7. Start iMessage watcher (optional - only if configured)
  console.log('[Gateway] Starting iMessage watcher...');
  const imsgResult = await startIMessage();
  imessageEnabled = imsgResult !== null;

  if (!imessageEnabled) {
    console.log('[Gateway] iMessage not configured');
  }

  // 8. Start Telegram bot (optional - only if configured)
  if (telegramAvailable && startTelegram) {
    try {
      console.log('[Gateway] Starting Telegram bot...');
      const telegramResult = await startTelegram();
      telegramEnabled = telegramResult !== null;
    } catch (err) {
      console.error('[Gateway] Failed to start Telegram:', err.message);
    }
  }

  if (!telegramEnabled) {
    console.log('[Gateway] Telegram not configured');
  }

  // Print status
  const jobs = getJobStatus();
  const skillNames = getSkillNames();
  const mcpManager = getMCPClientManager();
  const mcpStatus = mcpManager.getStatus();

  console.log('\n[Gateway] Active Jobs:');
  for (const job of jobs) {
    const status = job.active ? '✅' : '❌';
    console.log(`  ${status} ${job.name} (${job.cron})`);
  }

  console.log('\n[Gateway] Skills:');
  if (skillNames.length > 0) {
    console.log(`  ${skillNames.map(s => '/' + s).join(', ')}`);
  } else {
    console.log('  None loaded');
  }

  console.log('\n[Gateway] MCP Servers:');
  if (mcpStatus.length > 0) {
    for (const server of mcpStatus) {
      console.log(`  ✅ ${server.name}: ${server.tools} tools (${server.toolNames.join(', ')})`);
    }
  } else {
    console.log('  None connected');
  }

  const httpPort = getHttpPort();
  const httpHost = getHttpHost();

  console.log('\n[Gateway] ══════════════════════════════════════════════');
  console.log('[Gateway] Cal Gateway is LIVE');
  console.log(`[Gateway] - Telegram: ${telegramEnabled ? 'Listening for messages' : 'Disabled'}`);
  console.log(`[Gateway] - iMessage: ${imessageEnabled ? 'Listening for messages' : 'Disabled'}`);
  console.log(`[Gateway] - HTTP: http://${httpHost}:${httpPort}`);
  console.log('[Gateway] - Scheduler: Cron jobs active');
  console.log('[Gateway] - Skills: Available via /command');
  console.log('[Gateway] - MCP: Servers connected');
  console.log('[Gateway] - Session: Shared context enabled');
  console.log('[Gateway] ══════════════════════════════════════════════\n');

  // Send startup notification via configured chat channel
  if (telegramEnabled || imessageEnabled) {
    const startupMsg = `*Cal Gateway Started*\n\n` +
      `Time: ${startTime}\n` +
      `Version: ${VERSION}\n` +
      `Session: ${session.messages.length} messages in history\n` +
      `Jobs: ${jobs.filter(j => j.active).length} active\n` +
      `Skills: ${skillNames.length} loaded\n` +
      `MCP: ${mcpStatus.length} servers connected\n\n` +
      `_iMessage + Scheduler + Skills + MCP unified._`;
    await sendNotification(startupMsg);
  }
}

/**
 * Graceful shutdown
 */
async function shutdown() {
  console.log('\n[Gateway] Shutting down...');

  // Stop iMessage watcher
  stopIMessage();

  // Stop Telegram bot
  if (telegramEnabled && stopTelegram) {
    stopTelegram();
  }

  // Stop HTTP server
  stopHttpServer();

  // Stop scheduler
  stopScheduler();

  // Disconnect MCP clients
  const mcpManager = getMCPClientManager();
  await mcpManager.disconnectAll();

  // Flush sessions to disk
  flushToDisk();

  console.log('[Gateway] Goodbye!\n');
  process.exit(0);
}

// Handle shutdown signals
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Handle uncaught errors (keep daemon running)
process.on('uncaughtException', (err) => {
  console.error('[Gateway] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Gateway] Unhandled rejection:', reason);
});

// CLI commands
const args = process.argv.slice(2);

if (args[0] === 'test') {
  // Test mode: trigger a job immediately
  const jobId = args[1] || 'morning-brief';
  console.log(`[Gateway] Test mode: triggering job "${jobId}"...\n`);

  initSessionStore();

  triggerJob(jobId, executeJob)
    .then(response => {
      console.log('\n[Gateway] Test complete. Response:');
      console.log('─'.repeat(60));
      console.log(response);
      console.log('─'.repeat(60));
      flushToDisk();
      process.exit(0);
    })
    .catch(err => {
      console.error('[Gateway] Test failed:', err.message);
      process.exit(1);
    });

} else if (args[0] === 'status') {
  // Status mode: show job status and session info
  initSessionStore();
  const session = getMainSession();

  console.log('Cal Gateway Status:\n');

  console.log('Session:');
  console.log(`  ID: ${session.sessionId}`);
  console.log(`  Messages: ${session.messages.length}`);
  console.log(`  Initialized: ${session.isInitialized}`);
  console.log('');

  const jobs = getJobStatus();
  console.log('Jobs:');
  for (const job of jobs) {
    console.log(`  ${job.enabled ? '●' : '○'} ${job.name}`);
    console.log(`    ID: ${job.id}`);
    console.log(`    Cron: ${job.cron}`);
    console.log('');
  }

  process.exit(0);

} else {
  // Normal mode: start full daemon
  start();
}
