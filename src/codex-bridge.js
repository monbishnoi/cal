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
import {
  CODEX_NOTIFICATION_MODES,
  getCodexNotificationPolicy,
  handleCodexNotificationPolicyInput,
} from './codex-notification-policy.js';

const CODEX_STRAND_NAME = 'Codex';
const SESSION_INDEX_PATH = path.join(os.homedir(), '.codex', 'session_index.jsonl');
const SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
const STATE_DB_PATH = path.join(os.homedir(), '.codex', 'state_5.sqlite');
const SQLITE3_PATH = '/usr/bin/sqlite3';
const MAX_AUTONOMOUS_CYCLES = 3;

let CodexClass = null;
let codex = null;
let initAttempted = false;
let initError = null;
let codexFactoryForTest = null;
let sessionsDirForTest = null;
let sessionIndexPathForTest = null;
let stateDbPathForTest = null;
let responseAnalyzer = null;
let notificationSender = null;

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

export function configureCodexNotificationLoop({ analyzeResponse, notify } = {}) {
  responseAnalyzer = typeof analyzeResponse === 'function' ? analyzeResponse : null;
  notificationSender = typeof notify === 'function' ? notify : null;
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

function formatPendingFeedbackMessage(state, analysis, options = {}) {
  const questions = analysis.questions.length
    ? analysis.questions.map((question, index) => `${index + 1}. ${question}`).join('\n')
    : truncateText(state.finalResponse, 1600);
  const heading = options.unattended
    ? `🔄 Running unattended (${options.cycle}/${MAX_AUTONOMOUS_CYCLES})`
    : '⏳ Task pending feedback';

  return [
    heading,
    '',
    'Codex needs input:',
    questions,
    '',
    'Cal’s proposed answer:',
    analysis.draftAnswer || '(Cal could not produce a safe draft. Please answer Codex directly.)',
    '',
    options.unattended
      ? 'Cal is sending this answer back into the same Codex thread.'
      : 'Reply “yes” to approve, “no” to keep this pending, or type a replacement answer.',
  ].join('\n');
}

function normalizeAnalysis(value) {
  const questions = Array.isArray(value?.questions)
    ? value.questions.map(question => String(question || '').trim()).filter(Boolean)
    : [];
  const draftAnswer = String(value?.draftAnswer || '').trim();
  const hasOpenQuestions = value?.hasOpenQuestions === true || questions.length > 0;

  return {
    hasOpenQuestions,
    questions,
    draftAnswer,
  };
}

async function analyzeFinalResponse(state) {
  if (!responseAnalyzer || state.status !== 'completed') {
    return { hasOpenQuestions: false, questions: [], draftAnswer: '' };
  }

  try {
    const analysis = normalizeAnalysis(await responseAnalyzer({
      task: state.task,
      fullResponse: state.finalResponse,
      threadId: state.threadId,
    }));
    if (analysis.hasOpenQuestions && !analysis.draftAnswer) {
      console.warn(`[Codex Bridge] Open questions found for ${state.taskId || state.threadId}, but Cal did not return a draft.`);
    }
    return analysis;
  } catch (err) {
    console.warn(`[Codex Bridge] Response analysis failed: ${err.message}`);
    return {
      hasOpenQuestions: true,
      questions: ['Cal could not safely analyze the Codex response. Review the response before continuing.'],
      draftAnswer: '',
    };
  }
}

async function sendAttentionNotification(state) {
  if (!notificationSender) return;
  try {
    await notificationSender(
      `Codex needs input on “${truncateText(state.task, 90)}”. See the blue Codex strand in Cal.`
    );
  } catch (err) {
    console.warn(`[Codex Bridge] Could not send attention notification: ${err.message}`);
  }
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
  const eventState = status === 'working'
    ? 'processing'
    : status === 'attention'
      ? 'attention'
      : 'idle';
  publishEvent({
    type: 'status_changed',
    sessionId,
    runId: null,
    source: 'codex',
    payload: { state: eventState },
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
  const current = manager.getMetadata?.(sessionId)?.codex || {};
  manager.setMetadata(sessionId, {
    codex: {
      ...current,
      taskId: state.taskId || current.taskId || null,
      task: state.task || current.task || '',
      threadId: state.threadId || current.threadId || null,
      project: state.project || current.project,
      sandbox: state.sandbox || current.sandbox || 'restricted',
      pendingFeedback: state.pendingFeedback || null,
      autonomousCycles: state.autonomousCycles || 0,
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
      autonomousCycles: 0,
      pendingFeedback: null,
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
  await runCodexConversation(state, manager, strandSessionId, state.task, {
    allowThreadFallback: true,
    completionKind: 'task',
  });
}

async function executeCodexTurn(state, prompt, { allowThreadFallback = false } = {}) {
  state.status = 'working';
  state.startedAt = state.startedAt || new Date().toISOString();
  state.turnStartedAt = new Date().toISOString();
  state.completedAt = null;
  state.finalResponse = '';
  state.usage = null;
  state.error = null;

  try {
    const client = await ensureCodexClient();
    const sandboxProfile = resolveSandboxProfile(state.sandbox);
    const options = {
      workingDirectory: state.project,
      skipGitRepoCheck: true,
      ...sandboxProfile.options,
    };
    let thread;

    if (state.threadId) {
      try {
        thread = client.resumeThread(state.threadId, options);
      } catch (err) {
        if (!allowThreadFallback) throw err;
        const message = err?.message || String(err);
        console.warn(`[Codex Bridge] Could not resume Codex thread ${state.threadId}; starting a new thread: ${message}`);
        thread = client.startThread(options);
      }
    } else {
      thread = client.startThread(options);
    }

    const result = await thread.run(prompt);
    state.threadId = thread.id || state.threadId;
    state.status = 'completed';
    state.completedAt = new Date().toISOString();
    state.items = result.items || [];
    state.finalResponse = result.finalResponse || '';
    state.usage = result.usage || null;

    if (state.threadId) {
      await markCodexThreadVisibleInDesktop(state.threadId);
    }
  } catch (err) {
    state.status = 'failed';
    state.completedAt = new Date().toISOString();
    state.error = normalizeCodexError(err).message;
  }

  if (state.taskId) tasks.set(state.taskId, state);
  return state;
}

async function runCodexConversation(state, manager, sessionId, initialPrompt, options = {}) {
  let prompt = initialPrompt;
  let allowThreadFallback = options.allowThreadFallback === true;
  const completionKind = options.completionKind || 'turn';

  while (prompt) {
    setCodexStrandStatus(manager, sessionId, 'working');
    await executeCodexTurn(state, prompt, { allowThreadFallback });
    allowThreadFallback = false;
    updateCodexSessionMetadata(manager, sessionId, state);

    if (state.status === 'failed') {
      appendCodexResult(
        manager,
        sessionId,
        completionKind === 'task'
          ? formatTaskCompletionMessage(state)
          : formatCodexTurnCompletionMessage(state)
      );
      setCodexStrandStatus(manager, sessionId, 'ready');
      return state;
    }

    const analysis = await analyzeFinalResponse(state);
    if (!analysis.hasOpenQuestions) {
      state.pendingFeedback = null;
      updateCodexSessionMetadata(manager, sessionId, state);
      appendCodexResult(
        manager,
        sessionId,
        completionKind === 'task'
          ? formatTaskCompletionMessage(state)
          : formatCodexTurnCompletionMessage(state)
      );
      setCodexStrandStatus(manager, sessionId, 'ready');
      return state;
    }

    const policy = getCodexNotificationPolicy();
    if (
      policy.mode === CODEX_NOTIFICATION_MODES.DONT_ASK_ME &&
      analysis.draftAnswer &&
      state.autonomousCycles < MAX_AUTONOMOUS_CYCLES
    ) {
      state.autonomousCycles += 1;
      state.pendingFeedback = null;
      appendCodexResult(manager, sessionId, formatPendingFeedbackMessage(state, analysis, {
        unattended: true,
        cycle: state.autonomousCycles,
      }));
      updateCodexSessionMetadata(manager, sessionId, state);
      prompt = analysis.draftAnswer;
      continue;
    }

    state.status = 'attention';
    state.pendingFeedback = {
      questions: analysis.questions,
      draftAnswer: analysis.draftAnswer,
      codexResponse: state.finalResponse,
      createdAt: new Date().toISOString(),
      reason: state.autonomousCycles >= MAX_AUTONOMOUS_CYCLES
        ? 'autonomous-cycle-limit'
        : 'approval-required',
    };
    updateCodexSessionMetadata(manager, sessionId, state);
    appendCodexResult(manager, sessionId, formatPendingFeedbackMessage(state, analysis));
    setCodexStrandStatus(manager, sessionId, 'attention');
    await sendAttentionNotification(state);
    return state;
  }

  return state;
}

function isApproval(text) {
  return /^(yes|y|approve|approved|send it|go ahead|proceed)$/i.test(String(text || '').trim());
}

function isPureRejection(text) {
  return /^(no|n|reject|rejected|not yet)$/i.test(String(text || '').trim());
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
  const policyResult = handleCodexNotificationPolicyInput(messageText);
  if (policyResult) {
    appendCodexResult(manager, sessionId, policyResult.message);
    return {
      handled: true,
      result: { text: policyResult.message, usageStatus: null, command: true },
    };
  }

  if (!codexMeta.threadId) {
    const waiting = 'Codex is still starting this thread. Try again after the first task finishes.';
    appendCodexResult(manager, sessionId, waiting);
    return { handled: true, result: { text: waiting, usageStatus: null } };
  }

  if (codexMeta.pendingFeedback && isPureRejection(messageText)) {
    const waiting = 'Cal’s draft was not sent. This Codex task is still waiting for your direction. Reply with the answer or changes you want sent.';
    appendCodexResult(manager, sessionId, waiting);
    setCodexStrandStatus(manager, sessionId, 'attention');
    return { handled: true, result: { text: waiting, usageStatus: null } };
  }

  const outboundMessage = codexMeta.pendingFeedback && isApproval(messageText)
    ? String(codexMeta.pendingFeedback.draftAnswer || '').trim()
    : messageText;

  if (!outboundMessage) {
    const waiting = 'Cal does not have a draft to approve. Reply with the answer you want sent to Codex.';
    appendCodexResult(manager, sessionId, waiting);
    setCodexStrandStatus(manager, sessionId, 'attention');
    return { handled: true, result: { text: waiting, usageStatus: null } };
  }

  const state = {
    taskId: codexMeta.taskId || null,
    task: codexMeta.task || 'Codex Strand follow-up',
    status: 'working',
    threadId: codexMeta.threadId,
    project: codexMeta.project,
    sandbox: codexMeta.sandbox || 'restricted',
    autonomousCycles: 0,
    pendingFeedback: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    finalResponse: '',
    usage: null,
    error: null,
  };

  updateCodexSessionMetadata(manager, sessionId, state);
  appendCodexResult(manager, sessionId, formatCodexTurnSentMessage(outboundMessage));
  await runCodexConversation(state, manager, sessionId, outboundMessage, {
    completionKind: 'turn',
  });

  return {
    handled: true,
    result: {
      text: state.status === 'failed' ? state.error : state.finalResponse,
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
  responseAnalyzer = null;
  notificationSender = null;
  tasks.clear();
}
