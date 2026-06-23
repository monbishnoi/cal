/**
 * Codex SDK bridge for Cal Gateway.
 *
 * The SDK is loaded dynamically so CODEX_ENABLED=false has no dependency cost.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { getActiveSessionManager, isMultiSessionEnabled, setSessionMessageInterceptor } from './session-manager.js';
import { publishEvent } from './event-bus.js';

const CODEX_STRAND_NAME = 'Codex';
const SESSION_INDEX_PATH = path.join(os.homedir(), '.codex', 'session_index.jsonl');
const SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
const STATE_DB_PATH = path.join(os.homedir(), '.codex', 'state_5.sqlite');
const SQLITE3_PATH = '/usr/bin/sqlite3';

let CodexClass = null;
let codex = null;
let initAttempted = false;
let initError = null;
let codexFactoryForTest = null;
let sessionsDirForTest = null;
let sessionIndexPathForTest = null;
let stateDbPathForTest = null;

const tasks = new Map();
const CODEX_SANDBOX_PROFILES = {
  restricted: {
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
  },
  full: {
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    networkAccessEnabled: true,
  },
};

export function isCodexEnabled() {
  return String(process.env.CODEX_ENABLED || '').toLowerCase() === 'true';
}

export function validateCodexStartupConfig() {
  if (isCodexEnabled() && !isMultiSessionEnabled()) {
    throw new Error('CODEX_ENABLED=true requires MULTI_SESSION_ENABLED=true. Exiting.');
  }
}

function resolveSandboxProfile(sandbox) {
  const normalized = String(sandbox || 'restricted').toLowerCase();
  const name = CODEX_SANDBOX_PROFILES[normalized] ? normalized : 'restricted';
  return {
    name,
    options: CODEX_SANDBOX_PROFILES[name],
  };
}

export async function initializeCodexBridge() {
  if (!isCodexEnabled()) {
    return { enabled: false };
  }

  validateCodexStartupConfig();

  if (initAttempted) {
    return initError
      ? { enabled: true, ok: false, error: initError.message }
      : { enabled: true, ok: true };
  }

  initAttempted = true;

  try {
    if (!codexFactoryForTest && !CodexClass) {
      const sdk = await import('@openai/codex-sdk');
      CodexClass = sdk.Codex;
    }
    codex = createCodexClient();
    return { enabled: true, ok: true };
  } catch (err) {
    initError = normalizeCodexError(err);
    console.warn(`[Codex Bridge] Failed to initialize: ${initError.message}`);
    return { enabled: true, ok: false, error: initError.message };
  }
}

function createCodexClient() {
  if (codexFactoryForTest) {
    return codexFactoryForTest();
  }
  if (!CodexClass) {
    throw new Error('Codex SDK is not loaded yet.');
  }
  return new CodexClass();
}

async function ensureCodexClient() {
  if (!isCodexEnabled()) {
    throw new Error('Codex tools are disabled. Set CODEX_ENABLED=true to enable them.');
  }
  validateCodexStartupConfig();

  if (codex) return codex;

  if (initError) {
    throw initError;
  }

  if (codexFactoryForTest) {
    codex = codexFactoryForTest();
    return codex;
  }

  try {
    const sdk = await import('@openai/codex-sdk');
    CodexClass = sdk.Codex;
    codex = new CodexClass();
    initAttempted = true;
    return codex;
  } catch (err) {
    initAttempted = true;
    initError = normalizeCodexError(err);
    throw initError;
  }
}

function normalizeCodexError(err) {
  const message = err?.message || String(err);
  if (
    message.includes('Unable to locate Codex CLI binaries') ||
    message.includes('ENOENT') ||
    message.includes('not found')
  ) {
    return new Error(`Codex CLI is not installed or not available to Cal Gateway: ${message}`);
  }
  return new Error(message);
}

function truncateText(text, maxLength) {
  const normalized = String(text || '').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength).trimEnd()}...`;
}

function formatTokenThousands(usage) {
  const total = Number(usage?.input_tokens || 0) + Number(usage?.output_tokens || 0);
  if (!Number.isFinite(total) || total <= 0) return '0K';
  const thousands = total / 1000;
  if (thousands < 10) {
    return `${Number(thousands.toFixed(1))}K`;
  }
  return `${Math.round(thousands)}K`;
}

function formatDurationSeconds(startedAt, completedAt) {
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) {
    return '0';
  }
  return String(Math.round((completed - started) / 1000));
}

function formatTaskSentMessage(task) {
  const projectName = path.basename(task.project) || task.project;
  return [
    '📤 Task sent to Codex',
    '',
    truncateText(task.task, 150),
    '',
    `Project: ${projectName} | Sandbox: ${task.sandbox}`,
  ].join('\n');
}

function formatTaskCompletionMessage(task) {
  if (task.status === 'failed') {
    return [
      '❌ Task failed',
      '',
      task.error || 'Codex did not provide an error message.',
    ].filter(Boolean).join('\n');
  }

  const duration = formatDurationSeconds(task.startedAt, task.completedAt);
  const tokens = formatTokenThousands(task.usage);
  const finalResponse = truncateText(task.finalResponse || '(No final response)', 500);

  return [
    `✅ Task completed (${duration}s, ${tokens} tokens)`,
    '',
    finalResponse,
  ].join('\n');
}

function formatCodexTurnCompletionMessage(turn) {
  if (turn.status === 'failed') {
    return [
      '❌ Codex reply failed',
      '',
      turn.error || 'Codex did not provide an error message.',
    ].filter(Boolean).join('\n');
  }

  const duration = formatDurationSeconds(turn.startedAt, turn.completedAt);
  const tokens = formatTokenThousands(turn.usage);
  const finalResponse = truncateText(turn.finalResponse || '(No final response)', 500);

  return [
    `💬 Codex replied (${duration}s, ${tokens} tokens)`,
    '',
    finalResponse,
  ].join('\n');
}

function formatCodexTurnSentMessage(messageText) {
  return [
    '📤 Message sent to Codex',
    '',
    truncateText(messageText, 150),
  ].join('\n');
}

function publishSessionsChanged(manager, sessionId) {
  publishEvent({
    type: 'sessions_changed',
    sessionId,
    source: 'codex',
    payload: { sessions: manager.listActive() },
  });
}

function getOrCreateCodexRecord() {
  const manager = getActiveSessionManager();
  if (!manager) {
    throw new Error('No active session manager is available for the Codex Strand.');
  }

  let record = manager.findRecordByName(CODEX_STRAND_NAME);
  if (!record) {
    manager.createSession({ name: CODEX_STRAND_NAME, skipLimit: true });
    record = manager.findRecordByName(CODEX_STRAND_NAME);
    publishSessionsChanged(manager, record.sessionId);
  }

  return { manager, record };
}

function setCodexStrandStatus(manager, sessionId, status) {
  manager.setStatus(sessionId, status);
  publishEvent({
    type: 'status_changed',
    sessionId,
    runId: null,
    source: 'codex',
    payload: { state: status === 'working' ? 'processing' : 'idle' },
  });
  publishSessionsChanged(manager, sessionId);
}

function appendCodexResult(manager, sessionId, text) {
  manager.appendAssistantMessage(sessionId, text);
  publishEvent({
    type: 'response_complete',
    sessionId,
    runId: null,
    source: 'codex',
    payload: { text, messageId: `codex-${Date.now()}` },
  });
}

function updateCodexSessionMetadata(manager, sessionId, state) {
  if (!manager?.setMetadata) return;
  manager.setMetadata(sessionId, {
    codex: {
      threadId: state.threadId || null,
      project: state.project,
      sandbox: state.sandbox,
    },
  });
  publishSessionsChanged(manager, sessionId);
}

function escapeSqlString(value) {
  return String(value || '').replace(/'/g, "''");
}

function getDefaultCodexThreadId() {
  return String(process.env.CODEX_DEFAULT_THREAD_ID || '').trim() || null;
}

function resolveCodexThreadId(threadId) {
  return String(threadId || '').trim() || getDefaultCodexThreadId();
}

async function markCodexThreadVisibleInDesktop(threadId) {
  const stateDbPath = stateDbPathForTest || STATE_DB_PATH;

  if (!fs.existsSync(stateDbPath)) {
    console.warn(`[Codex Bridge] Could not update Codex Desktop source for ${threadId}: ${stateDbPath} not found`);
    return;
  }

  const sql = `UPDATE threads SET source = 'vscode' WHERE id = '${escapeSqlString(threadId)}';`;

  await new Promise((resolve) => {
    const child = spawn(SQLITE3_PATH, [stateDbPath, sql], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    child.on('error', err => {
      console.warn(`[Codex Bridge] Could not update Codex Desktop source for ${threadId}: ${err.message}`);
      resolve();
    });

    child.on('close', code => {
      if (code !== 0) {
        console.warn(`[Codex Bridge] Could not update Codex Desktop source for ${threadId}: sqlite3 exited ${code}${stderr ? `: ${stderr.trim()}` : ''}`);
      }
      resolve();
    });
  });
}

export async function sendCodexTask({ task, project, threadId, sandbox } = {}) {
  const taskText = String(task || '').trim();
  const projectPath = String(project || '').trim();
  const sandboxProfile = resolveSandboxProfile(sandbox);
  const sandboxOptions = sandboxProfile.options;

  if (!taskText) {
    return 'Error: codex_send requires a non-empty task.';
  }
  if (!projectPath) {
    return 'Error: codex_send requires a project directory.';
  }

  try {
    await ensureCodexClient();
    const { manager, record } = getOrCreateCodexRecord();
    const taskId = `codex-${randomUUID().slice(0, 8)}`;
    const state = {
      taskId,
      threadId: resolveCodexThreadId(threadId),
      status: 'working',
      task: taskText,
      project: projectPath,
      startedAt: new Date().toISOString(),
      completedAt: null,
      strandSessionId: record.sessionId,
      items: [],
      finalResponse: '',
      usage: null,
      error: null,
      sandbox: sandboxProfile.name,
      sandboxOptions,
    };

    tasks.set(taskId, state);
    updateCodexSessionMetadata(manager, record.sessionId, state);
    setCodexStrandStatus(manager, record.sessionId, 'working');
    appendCodexResult(manager, record.sessionId, formatTaskSentMessage(state));
    runCodexTaskInBackground(state, manager, record.sessionId);

    return JSON.stringify({
      taskId,
      threadId: state.threadId,
      status: 'working',
      strand: CODEX_STRAND_NAME,
      strandSessionId: record.sessionId,
    }, null, 2);
  } catch (err) {
    return `Error: ${normalizeCodexError(err).message}`;
  }
}

async function runCodexTaskInBackground(state, manager, strandSessionId) {
  try {
    const client = await ensureCodexClient();
    const options = {
      workingDirectory: state.project,
      skipGitRepoCheck: true,
      ...state.sandboxOptions,
    };
    let thread;
    if (state.threadId) {
      try {
        thread = client.resumeThread(state.threadId, options);
      } catch (err) {
        const message = err?.message || String(err);
        console.warn(`[Codex Bridge] Could not resume Codex thread ${state.threadId}; starting a new thread: ${message}`);
        thread = client.startThread(options);
      }
    } else {
      thread = client.startThread(options);
    }
    const prompt = state.task;
    const result = await thread.run(prompt);

    state.threadId = thread.id || state.threadId;
    state.status = 'completed';
    state.completedAt = new Date().toISOString();
    state.items = result.items || [];
    state.finalResponse = result.finalResponse || '';
    state.usage = result.usage || null;
  } catch (err) {
    state.status = 'failed';
    state.completedAt = new Date().toISOString();
    state.error = normalizeCodexError(err).message;
  } finally {
    if (state.status === 'completed' && state.threadId) {
      await markCodexThreadVisibleInDesktop(state.threadId);
    }
    tasks.set(state.taskId, state);
    updateCodexSessionMetadata(manager, strandSessionId, state);
    appendCodexResult(manager, strandSessionId, formatTaskCompletionMessage(state));
    setCodexStrandStatus(manager, strandSessionId, 'ready');
  }
}

async function handleCodexStrandMessage({ manager, record, sessionId, text }) {
  if (!isCodexEnabled()) {
    return null;
  }

  const codexMeta = record?.metadata?.codex || null;
  if (!codexMeta) {
    return null;
  }

  const messageText = String(text || '').trim();
  if (!messageText) {
    return { handled: true, result: { text: 'Error: Empty message', usageStatus: null } };
  }

  manager.appendUserMessage(sessionId, messageText);

  if (!codexMeta.threadId) {
    const waiting = 'Codex is still starting this thread. Try again after the first task finishes.';
    appendCodexResult(manager, sessionId, waiting);
    return { handled: true, result: { text: waiting, usageStatus: null } };
  }

  const turn = {
    status: 'working',
    threadId: codexMeta.threadId,
    project: codexMeta.project,
    sandbox: codexMeta.sandbox || 'restricted',
    startedAt: new Date().toISOString(),
    completedAt: null,
    finalResponse: '',
    usage: null,
    error: null,
  };

  setCodexStrandStatus(manager, sessionId, 'working');
  appendCodexResult(manager, sessionId, formatCodexTurnSentMessage(messageText));

  try {
    const client = await ensureCodexClient();
    const sandboxProfile = resolveSandboxProfile(turn.sandbox);
    const thread = client.resumeThread(turn.threadId, {
      workingDirectory: turn.project,
      skipGitRepoCheck: true,
      ...sandboxProfile.options,
    });
    const result = await thread.run(messageText);

    turn.threadId = thread.id || turn.threadId;
    turn.status = 'completed';
    turn.completedAt = new Date().toISOString();
    turn.finalResponse = result.finalResponse || '';
    turn.usage = result.usage || null;

    if (turn.threadId) {
      await markCodexThreadVisibleInDesktop(turn.threadId);
    }
    updateCodexSessionMetadata(manager, sessionId, turn);
  } catch (err) {
    turn.status = 'failed';
    turn.completedAt = new Date().toISOString();
    turn.error = normalizeCodexError(err).message;
  } finally {
    const responseText = formatCodexTurnCompletionMessage(turn);
    appendCodexResult(manager, sessionId, responseText);
    setCodexStrandStatus(manager, sessionId, 'ready');
  }

  return {
    handled: true,
    result: {
      text: turn.status === 'completed' ? turn.finalResponse : turn.error,
      usageStatus: null,
    },
  };
}

setSessionMessageInterceptor(handleCodexStrandMessage);

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function listCodexThreads(limit = 10) {
  const max = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(50, Number(limit))) : 10;
  const indexPath = sessionIndexPathForTest || SESSION_INDEX_PATH;
  const rows = readJsonl(indexPath)
    .filter(row => row.id)
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    .slice(0, max)
    .map(row => ({
      id: row.id,
      name: row.thread_name || '(untitled)',
      updatedAt: row.updated_at || null,
    }));

  return JSON.stringify({ threads: rows }, null, 2);
}

function findThreadFile(threadId) {
  const root = sessionsDirForTest || SESSIONS_DIR;
  if (!fs.existsSync(root)) return null;

  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(`${threadId}.jsonl`)) {
        return fullPath;
      }
    }
  }
  return null;
}

function textFromSessionEvent(event) {
  const payload = event.payload || {};
  if (payload.type === 'agent_message') return payload.message;
  if (payload.type === 'user_message') return payload.message;
  if (payload.type === 'function_call') return `${payload.name || 'tool'} ${payload.arguments || ''}`.trim();
  if (payload.type === 'function_call_output') return payload.output;
  if (event.type === 'response_item' && payload.type === 'message') {
    return (payload.content || [])
      .map(part => part.text || '')
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export function checkCodexThread(threadId) {
  const id = String(threadId || '').trim();
  if (!id) {
    return 'Error: codex_check requires threadId unless list=true.';
  }

  const indexRows = readJsonl(sessionIndexPathForTest || SESSION_INDEX_PATH);
  const index = indexRows.find(row => row.id === id) || {};
  const filePath = findThreadFile(id);
  if (!filePath) {
    return `Error: No Codex thread history found for ${id}.`;
  }

  const events = readJsonl(filePath);
  const messages = events
    .map(textFromSessionEvent)
    .map(text => String(text || '').trim())
    .filter(Boolean);
  const lastMessages = messages.slice(-5);
  const commands = events
    .filter(event => event.payload?.type === 'function_call')
    .map(event => event.payload?.name)
    .filter(Boolean)
    .slice(-5);
  const lastTimestamp = events.at(-1)?.timestamp || index.updated_at || null;

  return [
    `Codex thread: ${index.thread_name || id}`,
    `Thread ID: ${id}`,
    `Last activity: ${lastTimestamp || 'unknown'}`,
    commands.length ? `Recent tool calls: ${commands.join(', ')}` : 'Recent tool calls: none recorded',
    '',
    'Last activity summary:',
    ...lastMessages.map((message, idx) => `${idx + 1}. ${message.length > 500 ? message.slice(0, 500) + '...' : message}`),
  ].join('\n');
}

export function checkCodex({ list, limit, threadId } = {}) {
  if (list) {
    return listCodexThreads(limit || 10);
  }
  return checkCodexThread(threadId);
}

export function __setCodexFactoryForTest(factory) {
  codexFactoryForTest = factory;
  codex = null;
  initAttempted = false;
  initError = null;
}

export function __setCodexHistoryPathsForTest({ sessionIndexPath, sessionsDir } = {}) {
  sessionIndexPathForTest = sessionIndexPath || null;
  sessionsDirForTest = sessionsDir || null;
}

export function __setCodexStateDbPathForTest(stateDbPath) {
  stateDbPathForTest = stateDbPath || null;
}

export function __resetCodexBridgeForTest() {
  CodexClass = null;
  codex = null;
  initAttempted = false;
  initError = null;
  codexFactoryForTest = null;
  sessionsDirForTest = null;
  sessionIndexPathForTest = null;
  stateDbPathForTest = null;
  tasks.clear();
}
