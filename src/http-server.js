/**
 * HTTP/A2A Server for Cal Gateway
 *
 * Provides HTTP endpoints for A2A protocol (Agent-to-Agent) and static file serving.
 * Integrates Session Bridge for automatic context preservation.
 *
 * Session is owned by gateway.js and passed via setSession().
 */

import { createServer } from 'http';
import { randomUUID } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  performInSessionHandoff,
} from './session-bridge.js';
import { getAssistantConfig, getUserName } from './user-config.js';

import { sendMessage as sendIMessage } from './imessage.js';
import { sendMessage as sendTelegramMessage } from './telegram.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PWA_DIR = join(__dirname, '..', 'clients', 'pwa');

// Default port
const HTTP_PORT = process.env.CAL_HTTP_PORT || 8080;
const HTTP_HOST = process.env.CAL_HTTP_HOST || '0.0.0.0';

let httpServer = null;

// Session (set by gateway via setSession())
let session = null;

/**
 * Set the shared session (called by gateway.js)
 * @param {CalSession} s - The session instance owned by gateway
 */
export function setSession(s) {
  session = s;
}

/**
 * Get the current session
 * @returns {CalSession|null}
 */
export function getSession() {
  return session;
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
  const contextId = params?.contextId;

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

  // Use shared session (set by gateway.js)
  const session = getSession();
  const taskId = `task-${randomUUID()}`;

  try {
    console.log(`[A2A] Processing message: "${userMessage.substring(0, 50)}..."`);

    // Send to Claude and get response
    const result = await session.sendMessage(userMessage);

    // Session Bridge: Check if handoff needed
    let responseText = result.text;
    const usage = result.usageStatus;

    if (usage.thresholdHandoff && !usage.handoffTriggered) {
      console.log(`[A2A] Session Bridge: 90% threshold reached, performing in-session handoff`);
      await performInSessionHandoff(session);
      session.reset();
      console.log(`[A2A] Session Bridge: Session reset after handoff`);
      responseText += '\n\n---\nSession saved and refreshed. Continuing...';
    }

    console.log(`[A2A] Response ready (${responseText.length} chars)`);

    // Return A2A response
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id,
      result: {
        taskId,
        contextId: contextId || session.sessionId,
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
 * Handle A2A / direct agent-request
 * Supports both:
 * 1. Standard A2A JSON-RPC (method: "message/send")
 * 2. Simple direct format ({message, contextId})
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
    // Simple direct format: { message: "...", contextId: "..." }
    console.log(`[HTTP] Direct request format detected`);
    await handleDirectRequest(parsedBody, res);
  }
}

/**
 * Handle simple direct request format.
 */
async function handleDirectRequest(requestBody, res) {
  const userMessage = requestBody.message || requestBody.Message || '';
  const contextId = requestBody.contextId || requestBody.contextID || `http-${randomUUID()}`;

  if (!userMessage) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      message: 'Error: No message provided',
      type: 'finalAnswer',
      contextId,
    }));
    return;
  }

  console.log(`[HTTP] Processing: "${userMessage.substring(0, 50)}..." (context: ${contextId})`);

  // Use shared session (set by gateway.js)
  const session = getSession();

  try {
    // Send to Claude and get response
    const result = await session.sendMessage(userMessage);

    // Session Bridge: Check if handoff needed
    let responseText = result.text;
    const usage = result.usageStatus;

    if (usage.thresholdHandoff && !usage.handoffTriggered) {
      console.log(`[HTTP] Session Bridge: 90% threshold reached, performing in-session handoff`);
      await performInSessionHandoff(session);
      session.reset();
      console.log(`[HTTP] Session Bridge: Session reset after handoff`);
      responseText += '\n\n---\nSession saved and refreshed. Continuing...';
    }

    console.log(`[HTTP] Response ready (${responseText.length} chars)`);

    // Return direct response format
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      message: responseText,
      type: 'finalAnswer',
      contextId: contextId,
    }));

  } catch (err) {
    console.error(`[HTTP] Error processing message:`, err.message);

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

  let sender;
  if (channel === 'telegram') {
    sender = sendTelegramMessage;
  } else if (channel === 'imessage') {
    sender = sendIMessage;
  }

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
function handleHttpRequest(req, res) {
  console.log(`[HTTP] ${req.method} ${req.url}`);

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // CORS headers for cross-origin requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

  // Health check
  if (pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'cal-gateway' }));
    return;
  }

  // API: Send message to channel (used by MCP server)
  if (pathname === '/api/send-message' && req.method === 'POST') {
    handleSendMessage(req, res);
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
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch (err) {
    console.error('[HTTP] Error serving file:', err);
    res.writeHead(500);
    res.end('Internal server error');
  }
}

/**
 * Start HTTP server
 */
export async function startHttpServer() {
  return new Promise((resolve, reject) => {
    httpServer = createServer(handleHttpRequest);

    httpServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[HTTP] Port ${HTTP_PORT} is already in use`);
        reject(new Error(`Port ${HTTP_PORT} is in use`));
      } else {
        console.error('[HTTP] Server error:', err);
        reject(err);
      }
    });

    httpServer.listen(HTTP_PORT, HTTP_HOST, () => {
      console.log(`[HTTP] Server listening on http://${HTTP_HOST}:${HTTP_PORT}`);
      console.log(`[HTTP] A2A Agent Card: http://${HTTP_HOST}:${HTTP_PORT}/.well-known/agent.json`);
      resolve(httpServer);
    });
  });
}

/**
 * Stop HTTP server
 */
export function stopHttpServer() {
  if (httpServer) {
    console.log('[HTTP] Stopping server...');
    httpServer.close();
    httpServer = null;
  }
}

/**
 * Get HTTP port
 */
export function getHttpPort() {
  return HTTP_PORT;
}

/**
 * Get HTTP host
 */
export function getHttpHost() {
  return HTTP_HOST;
}
