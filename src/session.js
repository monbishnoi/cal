/**
 * CalSession - Manages a persistent AI conversation session
 *
 * Features:
 * - Persistent conversation history (disk-backed)
 * - Tool use loop with automatic retry
 * - Message validation and corruption repair
 * - Session Bridge: token tracking, handoffs, context exhaustion recovery
 */

import Anthropic from '@anthropic-ai/sdk';
import { loadSystemPrompt, getCurrentTimeContext } from './context.js';
import { getTools, executeToolCall } from './tools.js';
import { saveSession, getSession } from './session-store.js';
import { performInSessionHandoff } from './session-bridge.js';
import { logError } from './logger.js';
import { getLoopPilotGuidance } from './loop-pilot.js';

// API Configuration
const API_KEY = process.env.HYPERSPACE_PROXY_KEY || process.env.ANTHROPIC_API_KEY;
const BASE_URL = process.env.HYPERSPACE_PROXY_URL || 'http://localhost:6655/anthropic';
const MODEL = process.env.CAL_MODEL || 'anthropic--claude-4.6-opus';
const MAX_OUTPUT_TOKENS = parsePositiveInt(process.env.CAL_MAX_OUTPUT_TOKENS, 12000);

// Session Bridge: Context window limit (200K tokens for standard Opus)
const CONTEXT_LIMIT = parseInt(process.env.CAL_CONTEXT_LIMIT) || 200000;
const THRESHOLD_HANDOFF = 0.90;  // 90% - trigger in-session handoff, then reset
const THRESHOLD_MID_TOOL_HANDOFF = 0.85;  // 85% - schedule early handoff after tool loops reach a safe point
const MAX_MID_LOOP_RESETS = 3;  // Safety limit to prevent infinite handoff loops

export class CalSession {
  constructor(sessionId, options = {}) {
    this.sessionId = sessionId;
    this.persistEnabled = options.persist !== false;
    this.messages = [];
    this.isInitialized = false;
    this.systemPrompt = null;

    // Session Bridge: Token tracking
    this.tokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      lastUpdated: null,
    };
    this.handoffTriggered = false;  // Track if 90% handoff already ran
    this.midLoopResetCount = 0;  // Track mid-tool-loop resets to prevent infinite loops
    this.messageQueue = Promise.resolve();  // Serialize access to mutable message history
    this.isProcessingMessage = false;

    // Health detection: ring buffer of recent response lengths
    this.recentResponseLengths = [];

    // Steering: queued messages from the user injected between tool iterations
    this.steerQueue = [];

    // Initialize Anthropic client
    this.client = new Anthropic({
      apiKey: API_KEY,
      baseURL: BASE_URL,
    });

    this.model = MODEL;

    // Try to restore from disk for persistent sessions.
    if (this.persistEnabled) {
      this.restoreFromDisk();
    }
  }

  /**
   * Restore session state from disk if available
   */
  restoreFromDisk() {
    const saved = getSession(this.sessionId);
    if (saved && saved.messages && saved.messages.length > 0) {
      this.messages = saved.messages;
      this.systemPrompt = saved.systemPrompt || null;
      this.isInitialized = !!this.systemPrompt;

      // Session Bridge: Restore token tracking
      if (saved.tokenUsage) {
        this.tokenUsage = saved.tokenUsage;
      }
      if (saved.handoffTriggered) {
        this.handoffTriggered = saved.handoffTriggered;
      }
      if (saved.midLoopResetCount) {
        this.midLoopResetCount = saved.midLoopResetCount;
      }
      if (saved.visualHistory) {
        this.visualHistory = saved.visualHistory;
      }

      console.log(`[Session ${this.sessionId}] Restored ${this.messages.length} messages from disk`);
    }
  }

  /**
   * Persist session state to disk
   */
  persistToDisk() {
    if (!this.persistEnabled) return;
    saveSession(this.sessionId, {
      messages: this.messages,
      systemPrompt: this.systemPrompt,
      tokenUsage: this.tokenUsage,
      handoffTriggered: this.handoffTriggered,
      midLoopResetCount: this.midLoopResetCount,
      visualHistory: this.visualHistory || null,
    });
  }

  /**
   * Initialize session (load system prompt)
   */
  async initialize() {
    if (this.isInitialized) return;

    console.log(`[Session ${this.sessionId}] Initializing session...`);

    // Load CAL.md, MEMORY.md, USER.md as system prompt
    this.systemPrompt = loadSystemPrompt();

    this.isInitialized = true;
    console.log(`[Session ${this.sessionId}] Session initialized with ${this.messages.length} messages`);
  }

  /**
   * Validate message history integrity before sending to API.
   * Ensures every assistant tool_use has a following user tool_result.
   * If corrupted, truncates history to last valid state.
   */
  validateMessages() {
    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i];

      // Check if this is an assistant message with tool_use
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        const hasToolUse = msg.content.some(c => c.type === 'tool_use');

        if (hasToolUse) {
          const nextMsg = this.messages[i + 1];

          // Next message must exist, be role 'user', and contain tool_results
          if (!nextMsg || nextMsg.role !== 'user' || !Array.isArray(nextMsg.content)) {
            console.warn(`[Session ${this.sessionId}] Corrupted history at index ${i}: orphaned tool_use. Truncating.`);
            this.messages = this.messages.slice(0, i);
            return false;
          }

          // Verify all tool_use IDs have matching tool_result IDs
          const toolUseIds = msg.content.filter(c => c.type === 'tool_use').map(c => c.id);
          const toolResultIds = nextMsg.content.filter(c => c.type === 'tool_result').map(c => c.tool_use_id);

          for (const id of toolUseIds) {
            if (!toolResultIds.includes(id)) {
              console.warn(`[Session ${this.sessionId}] Missing tool_result for tool_use ${id}. Truncating.`);
              this.messages = this.messages.slice(0, i);
              return false;
            }
          }
        }
      }

      // Check for user tool_result blocks without the immediately preceding assistant tool_use.
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        const hasToolResult = msg.content.some(c => c.type === 'tool_result');

        if (hasToolResult) {
          const prevMsg = this.messages[i - 1];
          if (!prevMsg || prevMsg.role !== 'assistant' || !Array.isArray(prevMsg.content)) {
            console.warn(`[Session ${this.sessionId}] Corrupted history at index ${i}: orphaned tool_result. Truncating.`);
            this.messages = this.messages.slice(0, i);
            return false;
          }

          const toolResultIds = msg.content.filter(c => c.type === 'tool_result').map(c => c.tool_use_id);
          const toolUseIds = prevMsg.content.filter(c => c.type === 'tool_use').map(c => c.id);

          for (const id of toolResultIds) {
            if (!toolUseIds.includes(id)) {
              console.warn(`[Session ${this.sessionId}] tool_result ${id} has no matching tool_use. Truncating.`);
              this.messages = this.messages.slice(0, i);
              return false;
            }
          }
        }
      }
    }

    // Also ensure the last message isn't an orphaned assistant tool_use
    if (this.messages.length > 0) {
      const lastMsg = this.messages[this.messages.length - 1];
      if (lastMsg.role === 'assistant' && Array.isArray(lastMsg.content) &&
          lastMsg.content.some(c => c.type === 'tool_use')) {
        console.warn(`[Session ${this.sessionId}] Last message is orphaned tool_use. Removing.`);
        this.messages.pop();
        return false;
      }
    }

    return true;
  }

  /**
   * Send a message and get response (with tool use loop)
   * @param {string} userMessage - The user's message
   * @param {Object} options - Options
   * @param {Function} options.onToolCall - Callback when tool is called
   * @param {Function} options.onResponse - Callback for response chunks
   * @returns {Promise<{text: string, usageStatus: Object}>} - Response with usage status
   */
  async sendMessage(userMessage, options = {}) {
    if (options.internal && this.isProcessingMessage) {
      return this._sendMessage(userMessage, options);
    }

    const run = async () => {
      this.isProcessingMessage = true;
      try {
        return await this._sendMessage(userMessage, options);
      } finally {
        this.isProcessingMessage = false;
      }
    };

    const previous = this.messageQueue.catch(() => {});
    const next = previous.then(run);
    this.messageQueue = next.catch(() => {});
    return next;
  }

  async appendSystemNote(note) {
    const run = async () => {
      const text = typeof note === 'string' && note.trim()
        ? note
        : '[SYSTEM: Background event recorded.]';

      this.messages.push({
        role: 'user',
        content: text,
      });

      this.persistToDisk();
      return true;
    };

    const previous = this.messageQueue.catch(() => {});
    const next = previous.then(run);
    this.messageQueue = next.catch(() => {});
    return next;
  }

  async _sendMessage(userMessage, options = {}) {
    const { onToolCall, onToolResult, onResponse, maxIterations: customMaxIterations, isBackgroundJob, isHandoff } = options;

    if (!this.isInitialized) {
      await this.initialize();
    }

    // Capture original user message for continuation prompt (used if mid-tool-loop handoff occurs)
    const originalUserMessage = userMessage;

    // Reset mid-loop counter for new user requests, but not nested handoff prompts.
    if (!options.internal) {
      this.midLoopResetCount = 0;
    }

    console.log(`[Session ${this.sessionId}] Sending: ${userMessage.substring(0, 50)}...`);

    // Validate and repair message history
    const wasClean = this.validateMessages();
    if (!wasClean) {
      console.warn(`[Session ${this.sessionId}] History was repaired`);
      this.persistToDisk(); // Persist the repair immediately
    }

    // Add timestamp context and optional Loop Pilot guidance.
    const timeContext = getCurrentTimeContext();
    const loopPilotGuidance = await getLoopPilotGuidance(userMessage, {
      ...options,
      sessionId: this.sessionId,
      maxIterations: customMaxIterations || 10,
    });
    const messageContent = loopPilotGuidance
      ? `${timeContext}\n\n${loopPilotGuidance}\n\n${userMessage}`
      : `${timeContext}\n\n${userMessage}`;

    // Add user message to history
    this.messages.push({
      role: 'user',
      content: messageContent,
    });

    // Snapshot for rollback on failure
    const messageCountBeforeCall = this.messages.length;

    try {
      // Call Claude API with tool use loop
      let response = await this.callClaude();

      // Tool use loop
      let iterations = 0;
      const maxIterations = customMaxIterations || 10;  // Default 10 for interactive, can be overridden per-job
      let shouldHandoffAfterResponse = false;
      let deferredHandoffUsage = null;

      while (response.stop_reason === 'tool_use' && iterations < maxIterations) {
        iterations++;
        console.log(`[Session ${this.sessionId}] Tool use iteration ${iterations}`);

        // Extract tool use requests
        const toolUses = response.content.filter(c => c.type === 'tool_use');

        // Add assistant's response (with tool requests) to history
        this.messages.push({
          role: 'assistant',
          content: response.content,
        });

        // Execute all tool calls
        const toolResults = [];
        for (const toolUse of toolUses) {
          console.log(`[Session ${this.sessionId}] Executing tool: ${toolUse.name}`);

          if (onToolCall) {
            onToolCall(toolUse.name, toolUse.input);
          }

          try {
            const result = await executeToolCall(toolUse.name, toolUse.input, { session: this });

            if (onToolResult) {
              onToolResult(toolUse.name, false);
            }

            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: typeof result === 'string' ? result : JSON.stringify(result),
            });
          } catch (err) {
            console.error(`[Session ${this.sessionId}] Tool error:`, err.message);

            if (onToolResult) {
              onToolResult(toolUse.name, true);
            }

            // Log tool errors with structured data
            const isTimeout = err.message.includes('ETIMEDOUT') || err.message.includes('timed out');
            if (isTimeout) {
              logError('tool_timeout', {
                session: this.sessionId,
                tool: toolUse.name,
                message: userMessage?.substring(0, 100),
                error: err.message,
                iterations: `${iterations}/${maxIterations}`,
              });
            }

            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: `Error: ${err.message}`,
              is_error: true,
            });
          }
        }

        // Add tool results to history
        this.messages.push({
          role: 'user',
          content: toolResults,
        });

        // Continue conversation with tool results
        try {
          response = await this.callClaude();

          // Early handoff: Check if approaching context limit.
          // If Claude still wants tools, defer the actual reset until we have a final assistant response.
          const midLoopUsage = this.getUsageStatus();
          if (midLoopUsage.percentage >= THRESHOLD_MID_TOOL_HANDOFF && !this.handoffTriggered && !isHandoff) {
            // Safety check: don't reset infinitely
            if (this.midLoopResetCount >= MAX_MID_LOOP_RESETS) {
              console.warn(`[Session ${this.sessionId}] Hit max mid-loop resets (${MAX_MID_LOOP_RESETS}). Stopping to avoid infinite loop.`);
              // Force a summary and exit the loop
              const forceStopText = 'This task is quite large. Here\'s what I\'ve accomplished so far. Would you like me to continue in smaller chunks?';
              response = {
                ...response,
                content: [{ type: 'text', text: forceStopText }],
                stop_reason: 'end_turn'
              };
            } else {
              console.log(`[Session ${this.sessionId}] ${(midLoopUsage.percentage * 100).toFixed(1)}% reached mid-tool-loop, deferring handoff until a safe point`);

              // Log session bridge trigger with structured data
              logError('session_bridge', {
                session: this.sessionId,
                message: originalUserMessage?.substring(0, 100),
                percentage: midLoopUsage.percentageFormatted,
                recovery: 'Deferred until tool loop reaches a safe point',
              });

              // 1. Notify user via callback (if available)
              if (onToolCall) {
                onToolCall('system', { status: 'Finishing current step before saving progress...' });
              }

              shouldHandoffAfterResponse = true;
              deferredHandoffUsage = midLoopUsage;
            }
          }
        } catch (apiErr) {
          // Check if this is a context length error
          const isContextExhausted = apiErr.message && (
            apiErr.message.includes('context_length') ||
            apiErr.message.includes('too many tokens') ||
            apiErr.message.includes('request too large') ||
            apiErr.message.includes('maximum context length') ||
            apiErr.message.includes('context window')
          );

          if (isContextExhausted && this.midLoopResetCount < MAX_MID_LOOP_RESETS) {
            console.warn(`[Session ${this.sessionId}] Context exhausted mid-tool-loop. Emergency handoff.`);

            // Log context exhaustion with structured data
            logError('context_exhausted', {
              session: this.sessionId,
              message: originalUserMessage?.substring(0, 100),
              error: apiErr.message,
              recovery: 'Emergency handoff triggered',
            });

            // Emergency handoff - try to save what we can
            try {
              await performInSessionHandoff(this, { internal: true });
            } catch (handoffErr) {
              console.error(`[Session ${this.sessionId}] Emergency handoff failed:`, handoffErr.message);
            }

            this.midLoopResetCount++;
            this.reset();
            this.isInitialized = false;
            await this.initialize();

            // Inject continuation with context about what happened
            this.messages.push({
              role: 'user',
              content: `[SYSTEM: Context limit reached. Session refreshed. Continue working on: ${originalUserMessage}]`,
            });

            response = await this.callClaude();
            console.log(`[Session ${this.sessionId}] Emergency recovery complete, continuing task`);
          } else {
            console.error(`[Session ${this.sessionId}] API error during tool loop:`, apiErr.message);
            this.messages.push({
              role: 'assistant',
              content: [{ type: 'text', text: 'I encountered an error processing the tool results. Could you try again?' }],
            });
            throw apiErr;
          }
        }
      }

      if (iterations >= maxIterations) {
        console.warn(`[Session ${this.sessionId}] Hit max iterations (${maxIterations}). Requesting summary.`);

        // Log max iterations with structured data
        logError('max_iterations', {
          session: this.sessionId,
          message: userMessage?.substring(0, 100),
          iterations: `${iterations}/${maxIterations}`,
          recovery: 'Requesting summary from Cal',
        });

        // The last response is still tool_use. We need to:
        // 1. Execute those final tools
        // 2. Ask Cal to summarize instead of continuing

        const toolUses = response.content.filter(c => c.type === 'tool_use');
        if (toolUses.length > 0) {
          this.messages.push({
            role: 'assistant',
            content: response.content,
          });

          const toolResults = [];
          for (const toolUse of toolUses) {
            try {
              const result = await executeToolCall(toolUse.name, toolUse.input, { session: this });
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: String(result || '(no output)'),
              });
            } catch (toolErr) {
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: `Error: ${toolErr.message}`,
                is_error: true,
              });
            }
          }

          // Add tool results with a request to summarize
          // Different prompt for background jobs vs interactive
          const summaryPrompt = isBackgroundJob
            ? '[SYSTEM: Max tool iterations reached. Summarize what you accomplished and note any incomplete items for the log.]'
            : '[SYSTEM: I\'ve used my tool allowance for this request. Please summarize what I found so far and let the user know if there\'s more to explore. Be conversational — if the task isn\'t complete, offer to continue if they want me to dig deeper.]';

          this.messages.push({
            role: 'user',
            content: [
              ...toolResults,
              { type: 'text', text: summaryPrompt }
            ],
          });

          // Get final summary response
          try {
            response = await this.callClaude();

            // If Cal still wants to use tools, force extract text only
            if (response.stop_reason === 'tool_use') {
              console.warn(`[Session ${this.sessionId}] Cal still requesting tools after max iterations. Extracting text only.`);
              const textParts = response.content.filter(c => c.type === 'text');
              if (textParts.length > 0) {
                response = { ...response, content: textParts, stop_reason: 'end_turn' };
              } else {
                // No text at all, use fallback
                const fallbackText = isBackgroundJob
                  ? 'Task completed with multiple operations. Check the output for details.'
                  : 'I\'ve done quite a bit of research but haven\'t finished yet. Would you like me to continue? Just say "keep going" or "continue" and I\'ll pick up where I left off.';
                response = {
                  ...response,
                  content: [{ type: 'text', text: fallbackText }],
                  stop_reason: 'end_turn'
                };
              }
            }
          } catch (summaryErr) {
            console.error(`[Session ${this.sessionId}] Failed to get summary after max iterations:`, summaryErr.message);
            // Fall back to a canned response
            const fallbackText = isBackgroundJob
              ? 'Task ran but encountered an issue generating summary. Check logs for details.'
              : 'I ran into a snag while wrapping up. I\'ve done some work on your request — want me to try again or continue from here?';
            return {
              text: fallbackText,
              usageStatus: this.getUsageStatus(),
            };
          }
        }
      }

      // Final response (no more tools). If the model stopped before producing
      // usable text, never persist non-text blocks that would orphan tool calls.
      let finalContent = normalizeFinalAssistantContent(response, isBackgroundJob);
      if (finalContent !== response.content) {
        console.warn(`[Session ${this.sessionId}] Replaced incomplete final response (stop_reason=${response.stop_reason || 'unknown'})`);
      }

      this.messages.push({
        role: 'assistant',
        content: finalContent,
      });

      // Persist to disk
      this.persistToDisk();

      // Extract final text
      const textContent = finalContent.filter(c => c.type === 'text');
      let finalText = textContent.map(c => c.text).join('\n');

      if (shouldHandoffAfterResponse && !this.handoffTriggered) {
        const usage = deferredHandoffUsage || this.getUsageStatus();
        console.log(`[Session ${this.sessionId}] Safe point reached after tool loop, performing deferred handoff at ${usage.percentageFormatted}`);

        try {
          await performInSessionHandoff(this, { internal: true });
          this.midLoopResetCount++;
          this.reset();
          this.isInitialized = false;
          await this.initialize();
          finalText += '\n\n---\nSession saved and refreshed. Continuing...';
          console.log(`[Session ${this.sessionId}] Deferred handoff complete`);
        } catch (handoffErr) {
          console.error(`[Session ${this.sessionId}] Deferred handoff failed:`, handoffErr.message);
        }
      }

      console.log(`[Session ${this.sessionId}] Response complete (${finalText.length} chars)`);

      // Health detection: track response and maybe surface a hint
      this.recentResponseLengths.push(finalText.length);
      if (this.recentResponseLengths.length > 5) this.recentResponseLengths.shift();
      const hint = this.getHealthHint();
      if (hint) {
        finalText += `\n\n---\n${hint}`;
        console.log(`[Session ${this.sessionId}] Health hint surfaced`);
      }

      if (onResponse) {
        onResponse(finalText);
      }

      // Session Bridge: Return response with usage status
      const usageStatus = this.getUsageStatus();
      console.log(`[Session ${this.sessionId}] Token usage: ${usageStatus.percentageFormatted} (${usageStatus.totalTokens}/${usageStatus.contextLimit})`);

      return {
        text: finalText,
        usageStatus,
      };

    } catch (err) {
      // Check if this is a session corruption error
      const isCorruptionError = err.message && (
        // Orphaned tool_use/tool_result mismatch
        err.message.includes('tool_use') && err.message.includes('tool_result') ||
        err.message.includes('tool_use_id') ||
        err.message.includes('orphaned') ||
        // Empty content in messages
        err.message.includes('non-empty content') ||
        err.message.includes('empty content')
      );

      if (isCorruptionError) {
        console.error(`[Session ${this.sessionId}] Session corruption detected. Capturing context and resetting.`);

        // Log session corruption with structured data
        logError('session_corruption', {
          session: this.sessionId,
          message: userMessage?.substring(0, 100),
          error: err.message,
          recovery: 'Capturing context and resetting session',
        });

        // Capture recent context before reset (last 10 user/assistant text exchanges)
        const recentContext = this.extractRecentContext(10);

        // Complete reset
        this.messages = [];
        this.tokenUsage = { inputTokens: 0, outputTokens: 0, lastUpdated: null };
        this.handoffTriggered = false;
        this.handoffMessageIndex = null;

        // If we have context, inject it as a system-level recovery note
        // Cal will use this to provide continuity without dumping verbatim messages
        if (recentContext) {
          this.messages.push({
            role: 'user',
            content: `[SYSTEM: Session recovered from technical error. Here's the recent context from before the reset:\n${recentContext}\n\nPlease briefly acknowledge the reset and summarize what we were working on, then ask how to continue.]`,
          });
        }

        this.persistToDisk();

        // If we have context, let Cal generate a natural summary response
        if (recentContext) {
          try {
            const response = await this.callClaude();
            this.messages.push({
              role: 'assistant',
              content: response.content,
            });
            this.persistToDisk();

            const textContent = response.content.filter(c => c.type === 'text');
            const finalText = textContent.map(c => c.text).join('\n');

            return {
              text: finalText,
              usageStatus: this.getUsageStatus(),
              wasReset: true,
            };
          } catch (summaryErr) {
            console.error(`[Session ${this.sessionId}] Failed to generate recovery summary:`, summaryErr.message);
            // Fall through to simple message
          }
        }

        // Fallback: simple message if no context or summary failed
        return {
          text: "I ran into a technical issue and had to reset our conversation. I'm back online now — what can I help you with?",
          usageStatus: this.getUsageStatus(),
          wasReset: true,
        };
      }

      // Rollback on other failures
      if (this.messages.length === messageCountBeforeCall) {
        this.messages.pop();
        console.warn(`[Session ${this.sessionId}] Rolled back user message after error`);
      }

      this.validateMessages();
      this.persistToDisk(); // Persist the repair
      throw err;
    }
  }

  /**
   * Extract recent conversation context for recovery after corruption.
   * Returns a summary of recent exchanges, skipping tool_use/tool_result blocks.
   */
  extractRecentContext(maxExchanges = 10) {
    const context = [];
    let exchangeCount = 0;

    // Walk backwards through messages
    for (let i = this.messages.length - 1; i >= 0 && exchangeCount < maxExchanges; i--) {
      const msg = this.messages[i];

      // Extract text content only (skip tool_use/tool_result)
      let text = '';
      if (typeof msg.content === 'string') {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        const textParts = msg.content.filter(c => c.type === 'text').map(c => c.text);
        text = textParts.join('\n');
      }

      if (text && text.trim()) {
        // Strip timestamp prefix from user messages
        const cleanText = text.replace(/^\*\*[^*]+\*\* at \*\*[^*]+\*\*\n\n/, '').trim();

        if (cleanText) {
          const role = msg.role === 'user' ? 'You' : 'Cal';
          // Truncate long messages
          const truncated = cleanText.length > 200 ? cleanText.substring(0, 200) + '...' : cleanText;
          context.unshift(`- **${role}:** ${truncated}`);
          exchangeCount++;
        }
      }
    }

    return context.length > 0 ? context.join('\n') : null;
  }

  /**
   * Call Claude API with current message history
   */
  async callClaude() {
    this.drainSteerQueue();

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: this.systemPrompt,
      messages: this.messages,
      tools: getTools(),
      stream: false,
    });

    // Session Bridge: Track token usage
    if (response.usage) {
      this.tokenUsage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        lastUpdated: Date.now(),
      };
    }

    return response;
  }

  drainSteerQueue() {
    if (this.steerQueue.length === 0) {
      return false;
    }

    const steers = this.steerQueue.splice(0);
    const steerText = `[USER STEERING]: ${steers.join('\n')}`;
    console.log(`[Session ${this.sessionId}] Injecting ${steers.length} steer message(s)`);
    this.messages.push({
      role: 'user',
      content: steerText,
    });

    return true;
  }

  /**
   * Session Bridge: Get current usage status
   * Returns token counts and percentage of context limit
   */
  getUsageStatus() {
    const totalTokens = this.tokenUsage.inputTokens + this.tokenUsage.outputTokens;
    const percentage = totalTokens / CONTEXT_LIMIT;

    return {
      inputTokens: this.tokenUsage.inputTokens,
      outputTokens: this.tokenUsage.outputTokens,
      totalTokens,
      contextLimit: CONTEXT_LIMIT,
      percentage,
      percentageFormatted: (percentage * 100).toFixed(1) + '%',
      thresholdHandoff: percentage >= THRESHOLD_HANDOFF,
      handoffTriggered: this.handoffTriggered,
    };
  }

  /**
   * Get conversation history (for display)
   */
  getHistory() {
    return this.messages.map(msg => ({
      role: msg.role,
      content: typeof msg.content === 'string' ? msg.content : '[tool use]',
    }));
  }

  /**
   * Queue a steering message for injection before the next model call.
   */
  addSteer(text) {
    this.steerQueue.push(text);
    console.log(`[Session ${this.sessionId}] Steer queued: "${text.substring(0, 50)}"`);
  }

  /**
   * Clear conversation history (keep system prompt)
   */
  reset() {
    console.log(`[Session ${this.sessionId}] Resetting session`);

    // Preserve last 20 text exchanges for PWA visual continuity
    this.visualHistory = this.extractVisualHistory(20);

    this.messages = [];
    this.tokenUsage = { inputTokens: 0, outputTokens: 0, lastUpdated: null };
    this.handoffTriggered = false;
    this.handoffMessageIndex = null;
    this.recentResponseLengths = [];
    this.persistToDisk();
  }

  getHealthHint() {
    const recent = this.recentResponseLengths;
    const usage = this.getUsageStatus();

    // 2+ consecutive empty or near-empty responses
    if (recent.length >= 2) {
      const lastTwo = recent.slice(-2);
      if (lastTwo.every(len => len < 20)) {
        return 'Tip: Cal seems unresponsive. Type /reset to start a fresh session.';
      }
    }

    // 3+ very short responses while context is high
    if (recent.length >= 3 && usage.percentage > 0.7) {
      const lastThree = recent.slice(-3);
      if (lastThree.every(len => len < 100)) {
        return 'Tip: Session context is high and responses are getting short. Type /reset to free up space.';
      }
    }

    return null;
  }

  extractVisualHistory(limit = 20) {
    const history = [];
    for (let i = this.messages.length - 1; i >= 0 && history.length < limit; i--) {
      const msg = this.messages[i];
      let text = '';
      if (typeof msg.content === 'string') {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      }
      if (!text.trim() || text.trim().startsWith('[SYSTEM:')) continue;
      history.unshift({ role: msg.role, content: msg.content });
    }
    return history;
  }
}

function normalizeFinalAssistantContent(response, isBackgroundJob = false) {
  const content = Array.isArray(response?.content) ? response.content : [];
  const textParts = content.filter(part =>
    part?.type === 'text' &&
    typeof part.text === 'string' &&
    part.text.trim()
  );
  const hasNonTextBlocks = content.some(part => part?.type !== 'text');
  const stopReason = response?.stop_reason || 'unknown';

  if (content.length === 0) {
    return [{ type: 'text', text: buildIncompleteResponseText(stopReason, isBackgroundJob) }];
  }

  if (hasNonTextBlocks && stopReason !== 'tool_use') {
    return textParts.length > 0
      ? textParts
      : [{ type: 'text', text: buildIncompleteResponseText(stopReason, isBackgroundJob) }];
  }

  if (textParts.length === 0 && stopReason !== 'tool_use') {
    return [{ type: 'text', text: buildIncompleteResponseText(stopReason, isBackgroundJob) }];
  }

  return content;
}

function buildIncompleteResponseText(stopReason, isBackgroundJob = false) {
  if (isBackgroundJob) {
    return `The job stopped before producing a readable summary (stop reason: ${stopReason}). Check logs for details.`;
  }

  if (stopReason === 'max_tokens') {
    return 'I hit the response limit while preparing the next step, so I did not finish that turn. Please send it again, or say "continue" and I will pick it back up.';
  }

  return 'I finished processing, but the model returned no readable text. Please send that again, or say "continue" and I will pick it back up.';
}

function parsePositiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
