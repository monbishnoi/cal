/**
 * SessionManager owns PWA multi-session "Strands".
 *
 * Cal home is permanent. Strands are parallel, ephemeral CalSession instances
 * with independent history and queues, but shared tools, memory, and identity.
 */

import fs from 'fs';
import path from 'path';
import { CalSession } from './session.js';
import { deleteSession } from './session-store.js';
import { conversationRuntime } from './conversation-runtime.js';
import { MEMORY_DIR } from './paths.js';
import { getToday } from './context.js';
import { writeActiveContext } from './session-bridge.js';

export const HOME_SESSION_ID = 'cal-home';
export const MAX_STRANDS = 3;

let activeSessionManager = null;
let sessionMessageInterceptor = null;

export function isMultiSessionEnabled() {
  return String(process.env.MULTI_SESSION_ENABLED || '').toLowerCase() === 'true';
}

export function setActiveSessionManager(manager) {
  activeSessionManager = manager || null;
}

export function getActiveSessionManager() {
  return activeSessionManager;
}

export function setSessionMessageInterceptor(interceptor) {
  sessionMessageInterceptor = typeof interceptor === 'function' ? interceptor : null;
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function ensureDailyHeader(filePath, title) {
  if (fs.existsSync(filePath)) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `# ${title}\n`, 'utf8');
}

function appendToDailyLog(entry) {
  const today = getToday();
  const filePath = path.join(MEMORY_DIR, `${today}.md`);

  try {
    ensureDailyHeader(filePath, `Daily Log - ${today}`);
    fs.appendFileSync(filePath, entry, 'utf8');
  } catch (err) {
    console.warn(`[SessionManager] Failed to append Strand summary to ${filePath}: ${err.message}`);
  }
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

function historyForSearch(session) {
  return (session?.messages || [])
    .map((message, index) => {
      const content = textFromContent(message.content).trim();
      if (!content) return null;
      return {
        index,
        role: message.role,
        content,
      };
    })
    .filter(Boolean);
}

function meaningfulExchangeCount(messages) {
  return messages.filter(msg => msg.role === 'user' && textFromContent(msg.content).trim()).length;
}

function fallbackSummary(session) {
  const userMessages = session.messages
    .filter(msg => msg.role === 'user')
    .map(msg => textFromContent(msg.content).trim())
    .filter(Boolean)
    .slice(-5);

  if (userMessages.length === 0) {
    return 'No user messages were captured before this Strand closed.';
  }

  return [
    'Summary generation failed. Last user messages:',
    ...userMessages.map((text, index) => `${index + 1}. ${text.length > 500 ? text.slice(0, 500) + '...' : text}`),
  ].join('\n');
}

export class SessionManager {
  constructor({ homeSession, homeSessionId = HOME_SESSION_ID, maxStrands = MAX_STRANDS } = {}) {
    this.homeSessionId = homeSession?.sessionId || homeSessionId;
    this.maxStrands = maxStrands;
    this.sessions = new Map();

    if (homeSession) {
      this.registerHomeSession(homeSession);
    }

    setActiveSessionManager(this);
  }

  registerHomeSession(session) {
    this.sessions.set(this.homeSessionId, {
      sessionId: this.homeSessionId,
      name: 'Cal',
      runtime: session,
      status: session.isProcessingMessage ? 'working' : 'ready',
      createdAt: Date.now(),
      permanent: true,
      metadata: {},
    });
    conversationRuntime.setDefaultSession(session);
  }

  createSession(options = {}) {
    const activeStrands = this.listActive().filter(item => !item.permanent);
    if (!options.skipLimit && activeStrands.length >= this.maxStrands) {
      const err = new Error(`Maximum Strand limit reached (${this.maxStrands})`);
      err.statusCode = 409;
      throw err;
    }

    const number = activeStrands.length + 1;
    const requestedName = String(options.name || '').trim();
    const name = requestedName || (number === 1 ? 'Strand' : `Strand ${number}`);
    const sessionId = `strand-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const runtime = new CalSession(sessionId, { persist: false });

    const record = {
      sessionId,
      name,
      runtime,
      status: 'ready',
      createdAt: Date.now(),
      permanent: false,
      metadata: options.metadata || {},
    };

    this.sessions.set(sessionId, record);
    conversationRuntime.registerSession(runtime);
    return this.toPublicSession(record);
  }

  appendAssistantMessage(sessionId, text) {
    const record = this.getRecord(sessionId);
    if (!record?.runtime) {
      const err = new Error(`Unknown session: ${sessionId}`);
      err.statusCode = 404;
      throw err;
    }

    const messageText = String(text || '').trim();
    if (!messageText) return;

    record.runtime.messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: messageText }],
    });
  }

  appendUserMessage(sessionId, text) {
    const record = this.getRecord(sessionId);
    if (!record?.runtime) {
      const err = new Error(`Unknown session: ${sessionId}`);
      err.statusCode = 404;
      throw err;
    }

    const messageText = String(text || '').trim();
    if (!messageText) return;

    record.runtime.messages.push({
      role: 'user',
      content: messageText,
    });
  }

  setMetadata(sessionId, metadata = {}) {
    const record = this.getRecord(sessionId);
    if (!record) return null;
    record.metadata = {
      ...(record.metadata || {}),
      ...metadata,
    };
    return record.metadata;
  }

  getMetadata(sessionId) {
    return this.getRecord(sessionId)?.metadata || {};
  }

  getSession(sessionId) {
    const id = sessionId || this.homeSessionId;
    return this.sessions.get(id)?.runtime || null;
  }

  getRecord(sessionId) {
    return this.sessions.get(sessionId || this.homeSessionId) || null;
  }

  listActive() {
    return Array.from(this.sessions.values()).map(record => this.toPublicSession(record));
  }

  listObservationSessions() {
    return Array.from(this.sessions.values()).map(record => ({
      ...this.toPublicSession(record),
      runtime: record.runtime,
    }));
  }

  findByName(name) {
    const target = normalizeName(name);
    if (!target) return null;

    if (target === 'home' || target === 'main' || target === 'cal home') {
      return this.getSession(this.homeSessionId);
    }

    for (const record of this.sessions.values()) {
      if (normalizeName(record.name) === target) {
        return record.runtime;
      }
    }

    return null;
  }

  findRecordByName(name) {
    const target = normalizeName(name);
    if (!target) return null;

    if (target === 'home' || target === 'main' || target === 'cal home') {
      return this.getRecord(this.homeSessionId);
    }

    for (const record of this.sessions.values()) {
      if (normalizeName(record.name) === target) {
        return record;
      }
    }

    return null;
  }

  toPublicSession(record) {
    const status = record.runtime?.isProcessingMessage ? 'working' : record.status;
    return {
      sessionId: record.sessionId,
      name: record.name,
      status: status === 'working' || status === 'processing' ? 'working' : 'ready',
      createdAt: record.createdAt,
      permanent: !!record.permanent,
      messageCount: record.runtime?.messages?.length || 0,
    };
  }

  setStatus(sessionId, status) {
    const record = this.getRecord(sessionId);
    if (!record) return;
    record.status = status === 'working' || status === 'processing' ? 'working' : 'ready';
  }

  async routeMessage(sessionId, text, options = {}) {
    const record = this.getRecord(sessionId);
    const session = record?.runtime || null;
    if (!session) {
      const err = new Error(`Unknown session: ${sessionId}`);
      err.statusCode = 404;
      throw err;
    }

    if (sessionMessageInterceptor) {
      const intercepted = await sessionMessageInterceptor({
        manager: this,
        record,
        session,
        sessionId: session.sessionId,
        text,
        options,
      });
      if (intercepted?.handled) {
        return intercepted.result;
      }
    }

    return conversationRuntime.handleUserMessage({
      ...options,
      session,
      sessionId: session.sessionId,
      text,
    });
  }

  async summarizeAndDestroy(sessionId) {
    const record = this.getRecord(sessionId);
    if (!record) {
      const err = new Error(`Unknown session: ${sessionId}`);
      err.statusCode = 404;
      throw err;
    }
    if (record.permanent) {
      const err = new Error('Cal home cannot be closed');
      err.statusCode = 400;
      throw err;
    }

    const session = record.runtime;
    let summary = null;
    const shouldSummarize = meaningfulExchangeCount(session.messages || []) > 3;

    if (shouldSummarize) {
      try {
        const result = await session.sendMessage(
          'Summarize this Strand for the daily log in 3-5 concise lines. Focus on what was discussed, decided, or accomplished. Do not use tools.',
          { maxIterations: 1, isHandoff: true }
        );
        summary = result.text?.trim() || null;
      } catch (err) {
        console.warn(`[SessionManager] Summary failed for ${record.name}: ${err.message}`);
        summary = fallbackSummary(session);
      }
    }

    if (summary) {
      const closedAt = new Date().toLocaleString();
      appendToDailyLog(`\n\n### Strand closed - ${record.name}\n\nClosed: ${closedAt}\n\n${summary}\n`);
    }

    writeActiveContext(record, {
      closed: true,
      summary: summary || fallbackSummary(session),
      status: 'closed',
      currentStep: 'Strand closed.',
      reason: 'strand_close',
    });

    this.sessions.delete(sessionId);
    deleteSession(sessionId);
    return { closed: true, sessionId, name: record.name, summarized: !!summary };
  }

  injectContext(target, context) {
    const record = this.findRecordByName(target);
    if (!record?.runtime) {
      return `Error: No active session found for "${target}".`;
    }

    const text = String(context || '').trim();
    if (!text) {
      return 'Error: inject_context requires a non-empty context string.';
    }

    record.runtime.addSteer(`[Injected context]\n${text}`);
    return `Injected context into ${record.name}.`;
  }

  searchSession(target, query = '') {
    const record = this.findRecordByName(target);
    if (!record?.runtime) {
      return `Error: No active session found for "${target}".`;
    }

    const history = historyForSearch(record.runtime);
    const normalizedQuery = String(query || '').trim().toLowerCase();
    const results = normalizedQuery
      ? history.filter(message => message.content.toLowerCase().includes(normalizedQuery))
      : history.slice(-10);

    return JSON.stringify({
      sessionId: record.sessionId,
      name: record.name,
      query: normalizedQuery || null,
      resultCount: results.length,
      results,
    }, null, 2);
  }
}
