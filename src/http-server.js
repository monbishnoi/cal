/**
 * HTTP/A2A Server for Cal Gateway
 *
 * Provides HTTP endpoints for A2A protocol (Agent-to-Agent) and static file serving.
 * Enables compatible clients to call Cal through JSON-RPC.
 * Integrates Session Bridge for automatic context preservation.
 *
 * Session is owned by gateway.js and passed via setSession().
 */

import { execFileSync } from 'child_process';
import { createServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { randomUUID } from 'crypto';
import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { networkInterfaces } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { getAssistantConfig, getUserName } from './user-config.js';
import { GATEWAY_DIR, STARTUP_MEMORY_FILE, USER_FILE } from './paths.js';
import { generateConversationContext } from './conversation-context.js';
import { initWebPush, getVapidPublicKey, addSubscription, removeSubscription, sendWebPush, getSubscriptionCount } from './web-push.js';
import { eventBus } from './event-bus.js';
import { conversationRuntime } from './conversation-runtime.js';
import { getActiveSessionManager, isMultiSessionEnabled } from './session-manager.js';
import { getSkillPrompt, hasSkill } from './skills.js';

// OAuth callback handler set by an optional provider while authorization is in progress.
let oauthCallbackHandler = null;

/**
 * Register an OAuth callback handler.
 * Called by gateway.js when setting up an OAuth-backed integration.
 * @param {Function} handler - function(authorizationCode) to call when callback is received
 */
export function setOAuthCallbackHandler(handler) {
  oauthCallbackHandler = handler;
}

/**
 * Handle OAuth callback from browser redirect.
 * Extracts the authorization code and passes it to the registered handler.
 */
function handleOAuthCallback(url, res) {
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    console.error(`[OAuth] Authorization error: ${error}`);
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end(`
      <html><body>
        <h1>Authorization Failed</h1>
        <p>Error: ${error}</p>
        <p>${url.searchParams.get('error_description') || ''}</p>
        <p>You can close this window.</p>
      </body></html>
    `);
    return;
  }

  if (!code) {
    console.error('[OAuth] No authorization code in callback');
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end(`
      <html><body>
        <h1>Missing Authorization Code</h1>
        <p>No code parameter received. Please try again.</p>
      </body></html>
    `);
    return;
  }

  console.log(`[OAuth] Authorization code received: ${code.substring(0, 10)}...`);

  // Send success page to browser
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`
    <html><body>
      <h1>✅ Authorization Successful</h1>
      <p>Cal Gateway has been authorized to access the configured service.</p>
      <p>You can close this window and return to your chat.</p>
      <script>setTimeout(() => window.close(), 3000);</script>
    </body></html>
  `);

  // Deliver the code to the waiting auth flow
  if (oauthCallbackHandler) {
    oauthCallbackHandler(code);
    oauthCallbackHandler = null; // One-time use
  } else {
    console.warn('[OAuth] Received callback but no handler registered');
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PWA_DIR = join(__dirname, '..', 'clients', 'pwa');
const HISTORY_LIMIT = 80;
const HISTORY_IMAGE_MESSAGE_LIMIT = 20;
const MAX_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_MULTIPART_BODY_BYTES = MAX_IMAGE_UPLOAD_BYTES + 256 * 1024;
const MAX_VOICE_PROXY_BYTES = 1024 * 1024;
const MAX_VOICE_BENCHMARK_BYTES = 256 * 1024;
const DEFAULT_HTTPS_PORT = 8443;
const CERTS_DIR = join(GATEWAY_DIR, 'certs');
const VOICE_BENCHMARKS_PATH = join(GATEWAY_DIR, 'data', 'voice-benchmarks.jsonl');
const DEFAULT_CERT_PATH = join(CERTS_DIR, 'cert.pem');
const DEFAULT_KEY_PATH = join(CERTS_DIR, 'key.pem');
const SUPPORTED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

// Default port
const HTTP_PORT = process.env.CAL_HTTP_PORT || 8080;
const HTTP_HOST = process.env.CAL_HTTP_HOST || '0.0.0.0';
const DEFAULT_TALKBOX_URL = 'http://localhost:8090';

let httpServer = null;
let httpsServer = null;

function isHttpsEnabled() {
  return process.env.CAL_HTTPS === 'true';
}

function getHttpsPortConfig() {
  return process.env.CAL_HTTPS_PORT || DEFAULT_HTTPS_PORT;
}

function getHttpsCertPaths() {
  return {
    certPath: process.env.CAL_CERT_PATH || DEFAULT_CERT_PATH,
    keyPath: process.env.CAL_KEY_PATH || DEFAULT_KEY_PATH,
  };
}

function getCertificateAltNames() {
  const names = [{ type: 'DNS', value: 'localhost' }];
  const seen = new Set(['DNS:localhost']);

  function addIp(value) {
    if (!value || seen.has(`IP:${value}`)) return;
    seen.add(`IP:${value}`);
    names.push({ type: 'IP', value });
  }

  addIp('127.0.0.1');
  addIp('::1');

  for (const interfaces of Object.values(networkInterfaces())) {
    for (const entry of interfaces || []) {
      if (entry.internal) continue;
      addIp(entry.address);
    }
  }

  return names;
}

function writeOpenSslConfig(configPath) {
  const altNames = getCertificateAltNames()
    .map((entry, index) => `${entry.type}.${index + 1} = ${entry.value}`)
    .join('\n');

  writeFileSync(configPath, [
    '[req]',
    'distinguished_name = dn',
    'x509_extensions = v3_req',
    'prompt = no',
    '',
    '[dn]',
    'CN = localhost',
    '',
    '[v3_req]',
    'subjectAltName = @alt_names',
    '',
    '[alt_names]',
    altNames,
    '',
  ].join('\n'));
}

function ensureHttpsCertificate() {
  const { certPath, keyPath } = getHttpsCertPaths();
  if (existsSync(certPath) && existsSync(keyPath)) {
    return { certPath, keyPath, generated: false };
  }

  mkdirSync(dirname(certPath), { recursive: true });
  mkdirSync(dirname(keyPath), { recursive: true });
  const configPath = join(dirname(certPath), 'openssl.cnf');
  writeOpenSslConfig(configPath);

  try {
    execFileSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '365',
      '-nodes',
      '-config',
      configPath,
    ], { stdio: 'ignore' });
  } catch (err) {
    throw new Error(
      `CAL_HTTPS=true requires a TLS certificate, but Cal could not generate one with openssl. ` +
      `Install openssl or set CAL_CERT_PATH and CAL_KEY_PATH to existing PEM files. ` +
      `Original error: ${err.message}`
    );
  }

  return { certPath, keyPath, generated: true };
}

function loadHttpsOptions() {
  const { certPath, keyPath, generated } = ensureHttpsCertificate();
  if (generated) {
    console.log(`[HTTPS] Generated self-signed certificate at ${certPath}`);
  }
  return {
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
  };
}

// Session (set by gateway via setSession())
let session = null;
let sessionManager = null;
const channelSenders = new Map();

export function registerChannelSender(channel, sender) {
  if (!channel || typeof sender !== 'function') return;
  channelSenders.set(channel, sender);
}

/**
 * Set the shared session (called by gateway.js)
 * @param {CalSession} s - The session instance owned by gateway
 */
export function setSession(s) {
  session = s;
  conversationRuntime.setDefaultSession(s);
}

export function setSessionManager(manager) {
  sessionManager = manager || null;
}

/**
 * Get the current session
 * @returns {CalSession|null}
 */
export function getSession() {
  return session;
}

// --- WebSocket Server ---

let wss = null;
const wsClients = new Set();

/**
 * Internal broadcast function - sends to all connected clients.
 */
function broadcastToClients(event) {
  const data = JSON.stringify(event);
  for (const client of wsClients) {
    if (client.readyState === 1) client.send(data);
  }
}

function withSessionId(payload, sessionId) {
  if (sessionManager && isMultiSessionEnabled() && sessionId) {
    return { ...payload, sessionId };
  }
  return payload;
}

function missingSessionPayload(sessionId, error = 'No active session') {
  const payload = {
    type: 'run_error',
    sessionId,
    error,
    staleSession: true,
  };

  if (sessionManager && isMultiSessionEnabled()) {
    payload.sessions = sessionManager.listActive();
  }

  return payload;
}

function resolveSkillInvocation(text) {
  const match = String(text || '').trim().match(/^\/([\w-]+)/);
  if (!match) {
    return {
      text,
      activeSkill: null,
      handleCommands: true,
    };
  }

  const skillName = match[1].toLowerCase();
  if (!hasSkill(skillName)) {
    return {
      text,
      activeSkill: null,
      handleCommands: true,
    };
  }

  return {
    text: getSkillPrompt(skillName),
    activeSkill: skillName,
    handleCommands: false,
  };
}

function mapRuntimeEventToWebSocket(event) {
  if (event.source === 'job' && event.type !== 'proactive') {
    return null;
  }

  switch (event.type) {
    case 'run_started':
      return withSessionId({ type: 'run_started', runId: event.runId }, event.sessionId);
    case 'status_changed':
      return withSessionId({ type: 'status', state: event.payload?.state || 'idle' }, event.sessionId);
    case 'tool_call_started':
      return withSessionId({
        type: 'step_started',
        runId: event.runId,
        tool: event.payload?.tool,
        description: event.payload?.description,
        inputSummary: event.payload?.inputSummary || null,
      }, event.sessionId);
    case 'tool_call_finished':
      return withSessionId({
        type: 'step_finished',
        runId: event.runId,
        tool: event.payload?.tool,
        durationMs: event.payload?.durationMs,
        isError: !!event.payload?.isError,
      }, event.sessionId);
    case 'response_complete':
      return withSessionId({
        type: 'text_done',
        runId: event.runId,
        fullText: event.payload?.text || '',
        messageId: event.payload?.messageId,
      }, event.sessionId);
    case 'run_finished':
      return withSessionId({ type: 'run_finished', runId: event.runId }, event.sessionId);
    case 'run_error':
      return withSessionId({ type: 'run_error', runId: event.runId, error: event.payload?.error }, event.sessionId);
    case 'proactive':
      return withSessionId({ type: 'proactive', text: event.payload?.text || '', messageId: event.payload?.messageId }, event.sessionId);
    case 'steer_ack':
      return withSessionId({ type: 'steer_ack', text: event.payload?.text || '' }, event.sessionId);
    case 'sessions_changed':
      return { type: 'sessions', sessions: event.payload?.sessions || [] };
    default:
      return null;
  }
}

eventBus.subscribeAll((event) => {
  if (sessionManager && event.type === 'status_changed') {
    sessionManager.setStatus(event.sessionId, event.payload?.state || 'idle');
  }

  const wsEvent = mapRuntimeEventToWebSocket(event);
  if (wsEvent) {
    broadcastToClients(wsEvent);
  }
});

/**
 * Check if any WebSocket client is currently connected.
 */
export function wsIsConnected() {
  for (const client of wsClients) {
    if (client.readyState === 1) return true;
  }
  return false;
}

function handleWsConnection(ws) {
  console.log(`[WS] Client connected (${wsClients.size + 1} total)`);
  wsClients.add(ws);

  // Send actual session state on connect (not always 'idle')
  const currentSession = getSession();
  const state = currentSession?.isProcessingMessage ? 'processing' : 'idle';
  ws.send(JSON.stringify(withSessionId({ type: 'status', state }, currentSession?.sessionId)));
  if (sessionManager && isMultiSessionEnabled()) {
    ws.send(JSON.stringify({ type: 'sessions', sessions: sessionManager.listActive() }));
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
      return;
    }
    handleWsMessage(msg, ws);
  });

  ws.on('close', () => {
    wsClients.delete(ws);
    console.log(`[WS] Client disconnected (${wsClients.size} remaining)`);
  });

  ws.on('error', (err) => {
    console.error('[WS] Connection error:', err.message);
  });
}

async function handleWsMessage(msg, ws) {
  switch (msg.type) {
    case 'message':
      await handleWsChatMessage(msg, ws);
      break;

    case 'sync':
      handleWsSync(msg, ws);
      break;

    case 'typing':
    case 'presence':
      // Acknowledged, no action needed yet (future: route to proactive logic)
      break;

    case 'steer':
      handleWsSteer(msg);
      break;

    default:
      ws.send(JSON.stringify({ type: 'error', error: `Unknown message type: ${msg.type}` }));
  }
}

async function handleWsChatMessage(msg, ws) {
  const userMessage = msg.text;
  if (!userMessage || !userMessage.trim()) {
    ws.send(JSON.stringify({ type: 'run_error', sessionId: msg.sessionId, error: 'Empty message' }));
    return;
  }

  const currentSession = sessionManager && isMultiSessionEnabled()
    ? sessionManager.getSession(msg.sessionId)
    : getSession();
  if (!currentSession) {
    ws.send(JSON.stringify(missingSessionPayload(msg.sessionId)));
    return;
  }

  try {
    const skillInvocation = resolveSkillInvocation(userMessage);
    await conversationRuntime.handleUserMessage({
      source: 'pwa',
      text: skillInvocation.text,
      session: currentSession,
      handleCommands: skillInvocation.handleCommands,
      sessionOptions: {
        activeSkill: skillInvocation.activeSkill,
      },
    });
  } catch (err) {
    console.error('[WS] Error processing message:', err.message);
  }
}

function handleWsSync(msg, ws) {
  const limit = HISTORY_LIMIT;
  const targetSession = sessionManager && isMultiSessionEnabled()
    ? sessionManager.getSession(msg.sessionId)
    : getSession();
  const history = getHydratableHistory(limit, targetSession);
  ws.send(JSON.stringify({ type: 'history', ...history }));
}

function handleWsSteer(msg) {
  const text = msg.text?.trim();
  if (!text) return;

  const currentSession = sessionManager && isMultiSessionEnabled()
    ? sessionManager.getSession(msg.sessionId)
    : getSession();
  if (!currentSession) return;

  currentSession.addSteer(text);
  eventBus.publish({
    type: 'steer_ack',
    sessionId: currentSession.sessionId,
    source: 'pwa',
    payload: { text },
  });
}

function stripInjectedContext(text) {
  let cleaned = String(text || '')
    .replace(/^\*\*.+?\*\* at \*\*.+?\*\*\n\n/s, '')
    .trim();

  if (/^\[USER STEERING\]:/i.test(cleaned)) {
    return '';
  }

  const dynamicSkillEnd = '[END RELEVANT SKILL CONTEXT]';
  if (cleaned.startsWith('[SYSTEM:') && cleaned.includes(dynamicSkillEnd)) {
    cleaned = cleaned.slice(cleaned.indexOf(dynamicSkillEnd) + dynamicSkillEnd.length).trim();
  }

  return cleaned
    .replace(/^\[SYSTEM:[\s\S]*?\]\n\n?/i, '')
    .trim();
}

function getTextContent(content, displayContent = null) {
  let text = '';

  if (typeof displayContent === 'string' && displayContent.trim()) {
    text = displayContent;
  } else if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter(part => part?.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('\n');
  }

  if (text.trim().startsWith('[SYSTEM:')) {
    return '';
  }

  return stripInjectedContext(text);
}

function getHistoryImageAttachments(message) {
  if (!Array.isArray(message.content)) return [];

  const metadata = Array.isArray(message.attachments) ? message.attachments : [];
  return message.content
    .filter(part =>
      part?.type === 'image' &&
      part.source?.type === 'base64' &&
      typeof part.source.data === 'string' &&
      typeof part.source.media_type === 'string'
    )
    .map((part, index) => ({
      type: 'image',
      mediaType: part.source.media_type,
      dataUrl: `data:${part.source.media_type};base64,${part.source.data}`,
      filename: metadata[index]?.filename || metadata[index]?.name || null,
      size: metadata[index]?.size || null,
    }));
}

function getHydratableHistory(limit = HISTORY_LIMIT, targetSession = getSession()) {
  const currentSession = targetSession;

  if (!currentSession) {
    return {
      sessionId: null,
      messages: [],
      messageCount: 0,
      usageStatus: null,
      lastActivity: null,
    };
  }

  const visualHistory = (currentSession.visualHistory || []).map((msg, i) => ({
    ...msg, _preReset: true, _index: i,
  }));
  const currentMessages = currentSession.messages.map((msg, i) => ({
    ...msg, _preReset: false, _index: i,
  }));
  const allMessages = [...visualHistory, ...currentMessages];

  const messages = allMessages
    .map((message) => {
      const content = getTextContent(message.content, message.displayContent);
      if (!content) return null;

      return {
        id: `${currentSession.sessionId}-${message._preReset ? 'hist' : 'msg'}-${message._index}`,
        role: message.role,
        content,
        channel: message.channel || 'chat',
        sourceId: message.sourceId || null,
        voiceSessionId: message.voiceSessionId || null,
        preReset: message._preReset,
        attachments: getHistoryImageAttachments(message),
      };
    })
    .filter(Boolean)
    .slice(-limit);

  const imageMessageIds = new Set(messages
    .filter(message => message.role === 'user' && message.attachments.length > 0)
    .slice(-HISTORY_IMAGE_MESSAGE_LIMIT)
    .map(message => message.id));

  for (const message of messages) {
    if (!imageMessageIds.has(message.id)) {
      delete message.attachments;
    }
  }

  return {
    sessionId: currentSession.sessionId,
    messages,
    messageCount: currentSession.messages.length,
    usageStatus: currentSession.getUsageStatus?.() || null,
    lastActivity: Date.now(),
  };
}

function handleSessionHistory(url, res) {
  const limitParam = Number.parseInt(url.searchParams.get('limit'), 10);
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(limitParam, 1), 200)
    : HISTORY_LIMIT;
  const targetSession = sessionManager && isMultiSessionEnabled()
    ? sessionManager.getSession(url.searchParams.get('sessionId'))
    : getSession();

  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(getHydratableHistory(limit, targetSession)));
}

function readContextFile(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
  } catch (error) {
    console.warn(`[Voice] Could not read context file ${path}: ${error.message}`);
    return '';
  }
}

async function summarizeConversationForVoice(targetSession, conversation, maxTokens) {
  if (!targetSession?.client?.messages?.create) return '';

  const response = await targetSession.client.messages.create({
    model: targetSession.model,
    max_tokens: maxTokens,
    system: [
      'Create a compact continuity summary of the earlier conversation for Cal voice mode.',
      'Preserve decisions, established context, commitments, and unresolved points that affect what comes next.',
      'Do not add user-profile facts, project background from outside this transcript, tool mechanics, or speculation.',
      'Write direct factual prose. Do not mention that you are summarizing a transcript.',
    ].join(' '),
    messages: [{
      role: 'user',
      content: conversation,
    }],
  });

  return Array.isArray(response?.content)
    ? response.content
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n')
      .trim()
    : '';
}

async function handleVoiceContext(url, res) {
  const requestedSessionId = url.searchParams.get('sessionId');
  const targetSession = sessionManager && isMultiSessionEnabled()
    ? sessionManager.getSession(requestedSessionId)
    : getSession();

  if (!targetSession) {
    writeJson(res, 404, missingSessionPayload(requestedSessionId));
    return;
  }

  const history = getHydratableHistory(Number.MAX_SAFE_INTEGER, targetSession);
  const conversationContext = await generateConversationContext({
    sessionId: targetSession.sessionId,
    messages: history.messages,
    summarize: (conversation, maxTokens) =>
      summarizeConversationForVoice(targetSession, conversation, maxTokens),
  });

  writeJson(res, 200, {
    sessionId: targetSession.sessionId,
    layers: {
      user: readContextFile(USER_FILE),
      startupMemory: readContextFile(STARTUP_MEMORY_FILE),
      conversationContext,
    },
  });
}

async function handleVoiceWriteback(req, res) {
  try {
    const body = await readJsonBody(req);
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    const voiceSessionId = typeof body.voiceSessionId === 'string'
      ? body.voiceSessionId.trim().slice(0, 200)
      : null;
    const turns = Array.isArray(body.turns) ? body.turns : [];
    if (!sessionId) {
      writeJson(res, 400, { error: 'Missing sessionId' });
      return;
    }
    if (turns.length === 0 || turns.length > 10) {
      writeJson(res, 400, { error: 'turns must contain between 1 and 10 voice turns' });
      return;
    }

    const invalidTurn = turns.find(turn =>
      !['user', 'assistant'].includes(turn?.role)
      || typeof turn?.text !== 'string'
      || !turn.text.trim()
      || turn.text.length > 50_000
      || (turn.sourceId != null && (typeof turn.sourceId !== 'string' || turn.sourceId.length > 200))
    );
    if (invalidTurn) {
      writeJson(res, 400, { error: 'Each voice turn requires a valid role, text, and optional sourceId' });
      return;
    }

    const targetSession = sessionManager && isMultiSessionEnabled()
      ? sessionManager.getSession(sessionId)
      : getSession();
    if (!targetSession || (targetSession.sessionId !== sessionId && sessionId.startsWith('strand-'))) {
      writeJson(res, 404, { error: `Unknown or closed session: ${sessionId}` });
      return;
    }
    if (typeof targetSession.appendSilentTurns !== 'function') {
      writeJson(res, 501, { error: 'Session does not support silent writeback' });
      return;
    }

    const result = await targetSession.appendSilentTurns(turns, { channel: 'voice', voiceSessionId });
    writeJson(res, 200, {
      ok: true,
      sessionId: targetSession.sessionId,
      ...result,
    });
  } catch (err) {
    writeJson(res, err.statusCode || 500, { error: err.message });
  }
}

async function readJsonBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
  }
  if (!body.trim()) return {};
  return JSON.parse(body);
}

async function readRequestBuffer(req, maxBytes, errorMessage = 'Request body is too large.') {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const err = new Error(errorMessage);
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks, total);
}

function parseContentType(header = '') {
  const [type, ...parts] = String(header).split(';').map(part => part.trim());
  const params = {};
  for (const part of parts) {
    const [key, ...valueParts] = part.split('=');
    if (!key || valueParts.length === 0) continue;
    params[key.toLowerCase()] = valueParts.join('=').replace(/^"|"$/g, '');
  }
  return { type: type.toLowerCase(), params };
}

function parseContentDisposition(header = '') {
  const [, ...parts] = String(header).split(';').map(part => part.trim());
  const params = {};
  for (const part of parts) {
    const [key, ...valueParts] = part.split('=');
    if (!key || valueParts.length === 0) continue;
    params[key.toLowerCase()] = valueParts.join('=').replace(/^"|"$/g, '');
  }
  return params;
}

function splitBuffer(buffer, delimiter) {
  const parts = [];
  let start = 0;
  let index = buffer.indexOf(delimiter, start);

  while (index !== -1) {
    parts.push(buffer.subarray(start, index));
    start = index + delimiter.length;
    index = buffer.indexOf(delimiter, start);
  }

  parts.push(buffer.subarray(start));
  return parts;
}

function trimBoundaryPart(part) {
  let start = 0;
  let end = part.length;

  if (part.subarray(0, 2).toString() === '\r\n') start = 2;
  if (part.subarray(end - 2).toString() === '\r\n') end -= 2;
  if (part.subarray(end - 2, end).toString() === '--') end -= 2;
  if (part.subarray(end - 2).toString() === '\r\n') end -= 2;

  return part.subarray(start, end);
}

function parseMultipartFormData(buffer, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = [];

  for (const rawPart of splitBuffer(buffer, delimiter)) {
    const part = trimBoundaryPart(rawPart);
    if (!part.length) continue;

    const separator = Buffer.from('\r\n\r\n');
    const separatorIndex = part.indexOf(separator);
    if (separatorIndex === -1) continue;

    const headerText = part.subarray(0, separatorIndex).toString('utf8');
    const body = part.subarray(separatorIndex + separator.length);
    const headers = {};
    for (const line of headerText.split('\r\n')) {
      const splitAt = line.indexOf(':');
      if (splitAt === -1) continue;
      headers[line.slice(0, splitAt).trim().toLowerCase()] = line.slice(splitAt + 1).trim();
    }

    const disposition = parseContentDisposition(headers['content-disposition']);
    if (!disposition.name) continue;

    if (disposition.filename) {
      files.push({
        fieldName: disposition.name,
        filename: disposition.filename,
        contentType: (headers['content-type'] || 'application/octet-stream').toLowerCase(),
        buffer: body,
      });
    } else {
      fields[disposition.name] = body.toString('utf8');
    }
  }

  return { fields, files };
}

function imageAttachmentFromFile(file) {
  if (!file || file.buffer.length === 0) return null;
  if (!SUPPORTED_IMAGE_TYPES.has(file.contentType)) {
    const err = new Error('Unsupported image type. Use JPEG, PNG, GIF, or WebP.');
    err.statusCode = 415;
    throw err;
  }
  if (file.buffer.length > MAX_IMAGE_UPLOAD_BYTES) {
    const err = new Error('Image is too large. Maximum size is 5MB.');
    err.statusCode = 413;
    throw err;
  }

  return {
    type: 'image',
    mediaType: file.contentType,
    filename: file.filename,
    size: file.buffer.length,
    data: file.buffer.toString('base64'),
  };
}

async function readChatPayload(req) {
  const contentType = parseContentType(req.headers['content-type'] || '');

  if (contentType.type === 'multipart/form-data') {
    const boundary = contentType.params.boundary;
    if (!boundary) {
      const err = new Error('Missing multipart boundary');
      err.statusCode = 400;
      throw err;
    }

    const buffer = await readRequestBuffer(req, MAX_MULTIPART_BODY_BYTES, 'Upload is too large. Images must be 5MB or less.');
    const form = parseMultipartFormData(buffer, boundary);
    const imageFile = form.files.find(file => file.fieldName === 'image' || file.fieldName === 'file');
    const image = imageAttachmentFromFile(imageFile);
    const text = form.fields.message || form.fields.text || '';

    return {
      text: String(text || '').trim(),
      attachments: image ? [image] : [],
    };
  }

  const body = await readJsonBody(req);
  return {
    text: String(body.text || body.message || '').trim(),
    attachments: [],
  };
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function writeText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

async function handleVoiceBenchmark(req, res) {
  let body;
  try {
    const buffer = await readRequestBuffer(req, MAX_VOICE_BENCHMARK_BYTES, 'Voice benchmark payload is too large.');
    body = buffer.length ? JSON.parse(buffer.toString('utf8')) : {};
  } catch (err) {
    writeJson(res, err.statusCode || 400, { error: err.message || 'Invalid voice benchmark payload' });
    return;
  }

  const record = {
    receivedAt: new Date().toISOString(),
    source: 'pwa',
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
    id: typeof body.id === 'string' ? body.id : `voice-${Date.now()}`,
    payload: body,
  };

  try {
    mkdirSync(dirname(VOICE_BENCHMARKS_PATH), { recursive: true });
    appendFileSync(VOICE_BENCHMARKS_PATH, `${JSON.stringify(record)}\n`);
    writeJson(res, 200, { ok: true, path: VOICE_BENCHMARKS_PATH });
  } catch (err) {
    writeJson(res, 500, { error: err.message });
  }
}

async function proxyToTalkbox(req, res, {
  targetPath,
  fallbackContentType,
  errorFormat = 'json',
  timeoutMs = 90_000,
}) {
  let body;
  try {
    body = await readRequestBuffer(req, MAX_VOICE_PROXY_BYTES, 'Voice request body is too large.');
  } catch (err) {
    if (errorFormat === 'json') {
      writeJson(res, err.statusCode || 400, { error: err.message });
    } else {
      writeText(res, err.statusCode || 400, err.message);
    }
    return;
  }

  const headers = {};
  const contentType = req.headers['content-type'];
  if (contentType) headers['Content-Type'] = contentType;
  if (fallbackContentType) headers.Accept = fallbackContentType;
  const talkboxUrl = (process.env.TALKBOX_URL || DEFAULT_TALKBOX_URL).replace(/\/+$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${talkboxUrl}${targetPath}`, {
      method: req.method,
      headers,
      body,
      signal: controller.signal,
    });
    const text = await response.text();
    const responseType = response.headers.get('content-type') || fallbackContentType || 'application/octet-stream';
    writeText(res, response.status, text, responseType);
  } catch (err) {
    console.error(`[Voice] Talkbox proxy failed (${targetPath}):`, err.message);
    const message = err.name === 'AbortError'
      ? `Talkbox did not respond within ${Math.round(timeoutMs / 1000)} seconds.`
      : `Talkbox is not reachable at ${talkboxUrl}. Start Talkbox and try again.`;
    if (errorFormat === 'json') {
      writeJson(res, 502, { error: message, detail: err.message });
    } else {
      writeText(res, 502, message);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function requireSessionManager(res) {
  if (!isMultiSessionEnabled() || !sessionManager) {
    res.writeHead(404);
    res.end('Not found');
    return null;
  }
  return sessionManager;
}

function toObserverSession(session, overrides = {}) {
  return {
    sessionId: session?.sessionId || 'unknown',
    name: overrides.name || 'Cal',
    status: session?.isProcessingMessage ? 'working' : 'ready',
    permanent: overrides.permanent ?? true,
    messageCount: session?.messages?.length || 0,
  };
}

function handleObserverSessionsApi(res) {
  const manager = sessionManager || getActiveSessionManager();
  const sessions = manager && isMultiSessionEnabled()
    ? manager.listObservationSessions().map(({ runtime, ...publicSession }) => publicSession)
    : [toObserverSession(getSession())];

  writeJson(res, 200, {
    enabled: !!(manager && isMultiSessionEnabled()),
    sessions,
  });
}

async function handleSessionsApi(req, res, pathname) {
  const manager = requireSessionManager(res);
  if (!manager) return;

  try {
    if (pathname === '/api/sessions' && req.method === 'GET') {
      writeJson(res, 200, { enabled: true, sessions: manager.listActive() });
      return;
    }

    if (pathname === '/api/sessions' && req.method === 'POST') {
      const created = manager.createSession();
      broadcastToClients({ type: 'sessions', sessions: manager.listActive() });
      writeJson(res, 201, { session: created, sessions: manager.listActive() });
      return;
    }

    const messageMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/message$/);
    if (messageMatch && req.method === 'POST') {
      const sessionId = decodeURIComponent(messageMatch[1]);
      const body = await readChatPayload(req);
      const text = body.text || '';
      const skillInvocation = resolveSkillInvocation(text);
      const result = await manager.routeMessage(sessionId, skillInvocation.text, {
        source: 'pwa',
        handleCommands: skillInvocation.handleCommands,
        attachments: body.attachments || [],
        sessionOptions: {
          activeSkill: skillInvocation.activeSkill,
        },
      });
      writeJson(res, 200, { sessionId, message: result.text, usageStatus: result.usageStatus || null });
      return;
    }

    const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch && req.method === 'DELETE') {
      const result = await manager.summarizeAndDestroy(decodeURIComponent(sessionMatch[1]));
      broadcastToClients({ type: 'sessions', sessions: manager.listActive() });
      writeJson(res, 200, { ...result, sessions: manager.listActive() });
      return;
    }

    writeJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    const statusCode = err.statusCode || (err instanceof SyntaxError ? 400 : 500);
    const payload = { error: err.message };
    if (statusCode === 404 && /^Unknown session:/.test(err.message)) {
      payload.staleSession = true;
      payload.sessions = manager.listActive();
    }
    writeJson(res, statusCode, payload);
  }
}

async function handleDirectChatRequest(req, res) {
  const currentSession = getSession();
  if (!currentSession) {
    writeJson(res, 503, { error: 'No active session' });
    return;
  }

  try {
    const body = await readChatPayload(req);
    const text = body.text || '';
    const skillInvocation = resolveSkillInvocation(text);
    const result = await conversationRuntime.handleUserMessage({
      source: 'pwa',
      text: skillInvocation.text,
      session: currentSession,
      handleCommands: skillInvocation.handleCommands,
      attachments: body.attachments || [],
      sessionOptions: {
        activeSkill: skillInvocation.activeSkill,
      },
    });

    writeJson(res, 200, {
      message: result.text,
      usageStatus: result.usageStatus || null,
    });
  } catch (err) {
    writeJson(res, err.statusCode || (err instanceof SyntaxError ? 400 : 500), { error: err.message });
  }
}

/**
 * Get the A2A Agent Card
 */
function getAgentCard() {
  const assistant = getAssistantConfig();
  const userName = getUserName();

  return {
    name: assistant.name,
    description: `${userName}'s ${assistant.description}`,
    version: '1.0.0',
    url: `http://${HTTP_HOST}:${HTTP_PORT}/`,
    capabilities: {
      streaming: false,
      pushNotifications: false,
    },
    skills: [
      {
        id: 'chat',
        name: 'General Chat',
        description: 'Conversational AI assistant with access to calendar, email, notes, and file system',
        examples: [
          "What's on my calendar today?",
          "Check my unread emails",
          "Help me draft a response to this email",
          "What did we discuss yesterday?",
        ],
      },
    ],
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
  };
}

/**
 * Handle A2A message/send method
 */
async function handleMessageSend(rpcRequest, res) {
  const { id, params } = rpcRequest;
  const message = params?.message;
  const contextId = typeof params?.contextId === 'string'
    ? params.contextId.trim()
    : '';

  if (!message || !message.parts || message.parts.length === 0) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32602, message: 'Invalid params: message.parts required' },
      id,
    }));
    return;
  }

  // Extract text from message parts (handle various A2A formats)
  const textParts = message.parts.filter(p =>
    p.kind === 'text' || p.type === 'text' || (p.text && !p.kind && !p.type)
  );
  const userMessage = textParts.map(p => p.text).join('\n');

  if (!userMessage) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32602, message: 'Invalid params: no text content in message' },
      id,
    }));
    return;
  }

  const managedSession = sessionManager && isMultiSessionEnabled() && contextId
    ? sessionManager.getSession(contextId)
    : null;
  const session = managedSession || getSession();
  const taskId = `task-${randomUUID()}`;

  try {
    if (contextId.startsWith('strand-') && !managedSession) {
      const err = new Error(`Unknown or closed session: ${contextId}`);
      err.statusCode = 404;
      throw err;
    }

    const skillInvocation = resolveSkillInvocation(userMessage);
    const channel = params?.metadata?.channel === 'voice' ? 'voice' : null;
    const voiceSessionId = typeof params?.metadata?.voiceSessionId === 'string'
      ? params.metadata.voiceSessionId.slice(0, 200)
      : null;
    console.log(`[A2A] Processing message in ${session?.sessionId || 'unknown'}: "${userMessage.substring(0, 50)}..."`);

    const runtimeOptions = {
      source: 'a2a',
      text: skillInvocation.text,
      handleCommands: skillInvocation.handleCommands,
      sessionOptions: {
        activeSkill: skillInvocation.activeSkill,
        channel,
        voiceSessionId,
      },
    };
    const result = managedSession
      ? await sessionManager.routeMessage(contextId, skillInvocation.text, runtimeOptions)
      : await conversationRuntime.handleUserMessage({
        ...runtimeOptions,
        session,
      });
    const responseText = result.text;

    console.log(`[A2A] Response ready (${responseText.length} chars)`);

    // Return A2A response
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id,
      result: {
        taskId,
        contextId: managedSession?.sessionId || contextId || session.sessionId,
        state: 'completed',
        artifacts: [
          {
            name: 'response',
            parts: [{ kind: 'text', text: responseText }],
          },
        ],
      },
    }));

  } catch (err) {
    console.error(`[A2A] Error processing message:`, err.message);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id,
      result: {
        taskId,
        contextId: contextId || 'unknown',
        state: 'failed',
        error: { message: err.message },
      },
    }));
  }
}

/**
 * Handle an A2A agent request.
 * Supports both:
 * 1. Standard A2A JSON-RPC (method: "message/send")
 * 2. A simpler direct {message, contextId} body
 */
async function handleA2ARequest(req, res) {
  // Read request body
  let body = '';
  for await (const chunk of req) {
    body += chunk;
  }

  console.log(`[A2A] Raw request body: ${body.substring(0, 500)}`);

  let parsedBody;
  try {
    parsedBody = JSON.parse(body);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Parse error',
      message: 'Invalid JSON in request body',
    }));
    return;
  }

  // Detect request format
  if (parsedBody.jsonrpc === '2.0' && parsedBody.method) {
    // Standard A2A JSON-RPC format
    console.log(`[A2A] JSON-RPC request: ${parsedBody.method} (id: ${parsedBody.id})`);

    switch (parsedBody.method) {
      case 'message/send':
        await handleMessageSend(parsedBody, res);
        break;

      case 'tasks/get':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: parsedBody.id,
          error: { code: -32602, message: 'Task not found (tasks are not persisted)' },
        }));
        break;

      default:
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32601, message: `Method not found: ${parsedBody.method}` },
          id: parsedBody.id,
        }));
    }
  } else {
    console.log('[A2A] Direct request format detected');
    await handleDirectA2ARequest(parsedBody, res);
  }
}

/**
 * Handle the direct agent-request compatibility format.
 */
async function handleDirectA2ARequest(requestBody, res) {
  const userMessage = requestBody.message || requestBody.Message || '';
  const contextId = requestBody.contextId || requestBody.contextID || `direct-${randomUUID()}`;

  if (!userMessage) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      message: 'Error: No message provided',
      type: 'finalAnswer',
      contextId,
    }));
    return;
  }

  console.log(`[A2A] Processing direct request: "${userMessage.substring(0, 50)}..." (context: ${contextId})`);

  // Use shared session (set by gateway.js)
  const session = getSession();

  try {
    const skillInvocation = resolveSkillInvocation(userMessage);
    const result = await conversationRuntime.handleUserMessage({
      source: 'a2a',
      text: skillInvocation.text,
      session,
      handleCommands: skillInvocation.handleCommands,
      sessionOptions: {
        activeSkill: skillInvocation.activeSkill,
      },
    });
    const responseText = result.text;

    console.log(`[A2A] Direct response ready (${responseText.length} chars)`);

    // Return the direct compatibility response.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      message: responseText,
      type: 'finalAnswer',
      contextId: contextId,
    }));

  } catch (err) {
    console.error(`[A2A] Direct request failed:`, err.message);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      message: `Error: ${err.message}`,
      type: 'finalAnswer',
      contextId: contextId,
    }));
  }
}

/**
 * Handle /api/send-message - relay messages to channels (used by MCP server)
 */
async function handleSendMessage(req, res) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }

  const { channel, message } = parsed;

  if (!channel || !message) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing channel or message' }));
    return;
  }

  const sender = channelSenders.get(channel);

  if (!sender) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Channel not available: ${channel}` }));
    return;
  }

  try {
    await sender(message);
    console.log(`[HTTP] Relayed message to ${channel} (${message.length} chars)`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, channel, messageLength: message.length }));
  } catch (err) {
    console.error(`[HTTP] Error sending to ${channel}:`, err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message, channel }));
  }
}

/**
 * Handle HTTP requests
 */
async function handleHttpRequest(req, res) {
  console.log(`[HTTP] ${req.method} ${req.url}`);

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // CORS headers for cross-origin requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // A2A: Agent Card discovery
  if (pathname === '/.well-known/agent.json' && req.method === 'GET') {
    console.log('[A2A] Agent Card requested');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getAgentCard(), null, 2));
    return;
  }

  // A2A: JSON-RPC endpoint (POST to root)
  if (pathname === '/' && req.method === 'POST') {
    handleA2ARequest(req, res);
    return;
  }

  // API: clearer chat endpoint alias for the web UI.
  if (pathname === '/api/chat/send' && req.method === 'POST') {
    if (parseContentType(req.headers['content-type'] || '').type === 'multipart/form-data') {
      await handleDirectChatRequest(req, res);
      return;
    }
    handleA2ARequest(req, res);
    return;
  }

  if (pathname === '/voice/config' && req.method === 'GET') {
    writeJson(res, 200, { userName: getUserName() });
    return;
  }

  if (pathname === '/voice/session' && req.method === 'POST') {
    const sessionId = url.searchParams.get('sessionId');
    const targetPath = sessionId
      ? `/realtime/session?sessionId=${encodeURIComponent(sessionId)}`
      : '/realtime/session';
    await proxyToTalkbox(req, res, {
      targetPath,
      fallbackContentType: 'application/sdp',
      errorFormat: 'text',
      timeoutMs: 45_000,
    });
    return;
  }

  if (pathname === '/voice/ask-agent' && req.method === 'POST') {
    await proxyToTalkbox(req, res, {
      targetPath: '/realtime/ask-agent',
      fallbackContentType: 'application/json',
      errorFormat: 'json',
    });
    return;
  }

  if (pathname === '/voice/writeback' && req.method === 'POST') {
    await handleVoiceWriteback(req, res);
    return;
  }

  if (pathname === '/voice/progress' && req.method === 'POST') {
    await proxyToTalkbox(req, res, {
      targetPath: '/realtime/progress',
      fallbackContentType: 'application/json',
      errorFormat: 'json',
      timeoutMs: 10_000,
    });
    return;
  }

  if (pathname === '/voice/benchmarks' && req.method === 'POST') {
    await handleVoiceBenchmark(req, res);
    return;
  }

  if (pathname === '/api/voice/context' && req.method === 'GET') {
    await handleVoiceContext(url, res);
    return;
  }

  // Health check
  if (pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'cal-gateway' }));
    return;
  }

  // API: Hydrate the web UI with the current shared session.
  if ((pathname === '/api/chat/history' || pathname === '/api/session/history') && req.method === 'GET') {
    handleSessionHistory(url, res);
    return;
  }

  if (pathname === '/api/observer/sessions' && req.method === 'GET') {
    handleObserverSessionsApi(res);
    return;
  }

  if (pathname === '/api/sessions' || pathname.startsWith('/api/sessions/')) {
    await handleSessionsApi(req, res, pathname);
    return;
  }

  // API: Send message to channel (used by MCP server)
  if (pathname === '/api/send-message' && req.method === 'POST') {
    handleSendMessage(req, res);
    return;
  }

  // Push Notifications API
  if (pathname === '/api/push/vapid-public-key' && req.method === 'GET') {
    const key = getVapidPublicKey();
    if (!key) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'VAPID not configured' }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ key }));
    }
    return;
  }

  if (pathname === '/api/push/subscribe' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const subscription = JSON.parse(body);
        if (!subscription.endpoint || !subscription.keys) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid subscription object' }));
          return;
        }
        addSubscription(subscription);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  if (pathname === '/api/push/unsubscribe' && req.method === 'DELETE') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { endpoint } = JSON.parse(body);
        removeSubscription(endpoint);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  if (pathname === '/api/push/test' && req.method === 'POST') {
    const result = await sendWebPush({ title: 'Cal', body: 'Test notification — push is working!' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // OAuth callback (receives authorization code from browser redirect)
  if (pathname === '/oauth/callback' && req.method === 'GET') {
    handleOAuthCallback(url, res);
    return;
  }

  // PWA: Serve static files
  let filePath = pathname === '/' ? '/index.html' : pathname;

  // Security: prevent directory traversal
  if (filePath.includes('..')) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  const fullPath = join(PWA_DIR, filePath);

  // Check if file exists
  if (!existsSync(fullPath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  // Determine content type
  const ext = filePath.split('.').pop();
  const contentTypes = {
    'html': 'text/html',
    'js': 'application/javascript',
    'css': 'text/css',
    'json': 'application/json',
    'svg': 'image/svg+xml',
    'png': 'image/png',
  };

  const contentType = contentTypes[ext] || 'text/plain';

  // Read and serve file
  try {
    const content = readFileSync(fullPath);
    const headers = { 'Content-Type': contentType };
    if (ext === 'html' || ext === 'js') {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    }
    res.writeHead(200, headers);
    res.end(content);
  } catch (err) {
    console.error('[HTTP] Error serving file:', err);
    res.writeHead(500);
    res.end('Internal server error');
  }
}

function attachWebSocketUpgrade(server) {
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });
}

function listen(server, port, host, label) {
  return new Promise((resolve, reject) => {
    function onError(err) {
      server.off('listening', onListening);
      if (err.code === 'EADDRINUSE') {
        console.error(`[${label}] Port ${port} is already in use`);
        reject(new Error(`Port ${port} is in use`));
      } else {
        console.error(`[${label}] Server error:`, err);
        reject(err);
      }
    }

    function onListening() {
      server.off('error', onError);
      resolve();
    }

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * Start HTTP server, plus optional HTTPS server when CAL_HTTPS=true.
 */
export async function startHttpServer() {
  initWebPush();

  httpServer = createServer(handleHttpRequest);
  wss = new WebSocketServer({ noServer: true });
  wss.on('connection', handleWsConnection);
  attachWebSocketUpgrade(httpServer);

  try {
    await listen(httpServer, HTTP_PORT, HTTP_HOST, 'HTTP');
    const httpAddress = httpServer.address();
    const httpPort = httpAddress && typeof httpAddress === 'object' ? httpAddress.port : HTTP_PORT;
    console.log(`[HTTP] Server listening on http://${HTTP_HOST}:${httpPort}`);
    console.log(`[HTTP] WebSocket endpoint: ws://${HTTP_HOST}:${httpPort}/ws`);
    console.log(`[HTTP] A2A Agent Card: http://${HTTP_HOST}:${httpPort}/.well-known/agent.json`);

    if (isHttpsEnabled()) {
      const httpsOptions = loadHttpsOptions();
      httpsServer = createHttpsServer(httpsOptions, handleHttpRequest);
      attachWebSocketUpgrade(httpsServer);
      await listen(httpsServer, getHttpsPortConfig(), HTTP_HOST, 'HTTPS');
      const httpsAddress = httpsServer.address();
      const httpsPort = httpsAddress && typeof httpsAddress === 'object' ? httpsAddress.port : getHttpsPortConfig();
      console.log(`[HTTPS] Server listening on https://${HTTP_HOST}:${httpsPort}`);
      console.log(`[HTTPS] WebSocket endpoint: wss://${HTTP_HOST}:${httpsPort}/ws`);
      console.log(`[HTTPS] iOS PWA URL: https://<mac-lan-ip>:${httpsPort}/`);
    }
  } catch (err) {
    stopHttpServer();
    throw err;
  }

  return httpServer;
}

/**
 * Stop HTTP server
 */
export function stopHttpServer() {
  for (const client of wsClients) {
    try {
      client.terminate();
    } catch {
      // Ignore shutdown races.
    }
  }
  wsClients.clear();

  if (httpsServer) {
    console.log('[HTTPS] Stopping server...');
    httpsServer.close();
    httpsServer = null;
  }

  if (httpServer) {
    console.log('[HTTP] Stopping server...');
    httpServer.close();
    httpServer = null;
  }

  if (wss) {
    wss.close();
    wss = null;
  }
}

/**
 * Get HTTP port
 */
export function getHttpPort() {
  return HTTP_PORT;
}

/**
 * Get configured or active HTTPS port.
 */
export function getHttpsPort() {
  const address = httpsServer?.address();
  if (address && typeof address === 'object') {
    return address.port;
  }
  return getHttpsPortConfig();
}
