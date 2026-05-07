/**
 * ConversationRuntime is the single orchestration boundary for channel turns.
 *
 * CalSession still owns mutable conversation history and serialization.
 * Runtime owns normalized command intake, lifecycle events, and handoff policy.
 */

import { randomUUID } from 'crypto';
import { publishEvent } from './event-bus.js';
import { handleCommand } from './commands.js';
import { performInSessionHandoff } from './session-bridge.js';

function describeToolCall(toolName, input) {
  let name = String(toolName || 'tool')
    .replace(/^[a-z0-9]+_/, '')
    .replace(/_/g, ' ');

  name = name.charAt(0).toUpperCase() + name.slice(1);

  const context = input?.query ||
    input?.command?.substring(0, 50) ||
    input?.path?.split('/').pop() ||
    input?.filename ||
    input?.title ||
    input?.timeframe ||
    '';

  return context ? `${name}: ${context}` : name;
}

class ConversationRuntime {
  constructor() {
    this.defaultSession = null;
    this.sessions = new Map();
  }

  setDefaultSession(session) {
    this.defaultSession = session;
    if (session?.sessionId) {
      this.sessions.set(session.sessionId, session);
    }
  }

  registerSession(session) {
    if (session?.sessionId) {
      this.sessions.set(session.sessionId, session);
    }
  }

  getSession(sessionId) {
    if (sessionId) {
      return this.sessions.get(sessionId) || null;
    }
    return this.defaultSession;
  }

  async handleUserMessage(input = {}) {
    const {
      text,
      source = 'unknown',
      sessionId = null,
      session = null,
      externalId = null,
      replyTarget = null,
      handleCommands = true,
      enableHandoff = true,
      sessionOptions = {},
    } = input;

    const messageText = typeof text === 'string' ? text.trim() : '';
    const activeSession = session || this.getSession(sessionId);
    if (!activeSession) {
      throw new Error('No active session');
    }
    if (!messageText) {
      throw new Error('Empty message');
    }

    const runId = `run-${randomUUID().slice(0, 8)}`;
    const runtimeSessionId = activeSession.sessionId;

    publishEvent({
      type: 'message_received',
      sessionId: runtimeSessionId,
      runId,
      source,
      payload: { text: messageText, externalId, replyTarget },
    });
    publishEvent({ type: 'run_started', sessionId: runtimeSessionId, runId, source });
    publishEvent({
      type: 'status_changed',
      sessionId: runtimeSessionId,
      runId,
      source,
      payload: { state: 'processing' },
    });

    try {
      if (handleCommands) {
        const cmdResult = handleCommand(messageText, activeSession);
        if (cmdResult) {
          const response = cmdResult.response;
          publishEvent({
            type: 'response_complete',
            sessionId: runtimeSessionId,
            runId,
            source,
            payload: { text: response, messageId: `msg-${Date.now()}`, command: true },
          });
          publishEvent({ type: 'run_finished', sessionId: runtimeSessionId, runId, source });
          return { text: response, usageStatus: activeSession.getUsageStatus?.() || null, command: true };
        }
      }

      const originalOnToolCall = sessionOptions.onToolCall;
      const originalOnToolResult = sessionOptions.onToolResult;

      const result = await activeSession.sendMessage(messageText, {
        ...sessionOptions,
        onToolCall: (toolName, toolInput) => {
          publishEvent({
            type: 'tool_call_started',
            sessionId: runtimeSessionId,
            runId,
            source,
            payload: {
              tool: toolName,
              input: toolInput,
              description: toolName === 'system'
                ? toolInput?.status || 'Processing...'
                : describeToolCall(toolName, toolInput),
            },
          });
          if (originalOnToolCall) {
            originalOnToolCall(toolName, toolInput);
          }
        },
        onToolResult: (toolName, isError) => {
          publishEvent({
            type: 'tool_call_finished',
            sessionId: runtimeSessionId,
            runId,
            source,
            payload: { tool: toolName, isError: !!isError },
          });
          if (originalOnToolResult) {
            originalOnToolResult(toolName, isError);
          }
        },
      });

      let responseText = result.text;
      const usage = result.usageStatus;

      if (enableHandoff && usage?.thresholdHandoff && !usage.handoffTriggered) {
        console.log(`[Runtime] Session Bridge: threshold reached for ${source}, performing in-session handoff`);
        await performInSessionHandoff(activeSession);
        activeSession.reset();
        console.log('[Runtime] Session Bridge: session reset after handoff');
        responseText += '\n\n---\nSession saved and refreshed. Continuing...';
      }

      const finalResult = { ...result, text: responseText };
      publishEvent({
        type: 'response_complete',
        sessionId: runtimeSessionId,
        runId,
        source,
        payload: { text: responseText, messageId: `msg-${Date.now()}` },
      });
      publishEvent({ type: 'run_finished', sessionId: runtimeSessionId, runId, source });
      return finalResult;
    } catch (err) {
      publishEvent({
        type: 'run_error',
        sessionId: runtimeSessionId,
        runId,
        source,
        payload: { error: err.message },
      });
      throw err;
    } finally {
      publishEvent({
        type: 'status_changed',
        sessionId: runtimeSessionId,
        runId,
        source,
        payload: { state: 'idle' },
      });
    }
  }
}

export const conversationRuntime = new ConversationRuntime();
