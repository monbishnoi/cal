import { createHash } from 'crypto';

const DEFAULT_MAX_TOKENS = 6_000;
const DEFAULT_RECENT_TOKENS = 3_500;
const DEFAULT_SUMMARY_TOKENS = 2_500;
const CHARS_PER_TOKEN = 4;
const summaryCache = new Map();

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || '').length / CHARS_PER_TOKEN));
}

function clipToTokens(text, maxTokens) {
  const maxChars = Math.max(1, maxTokens) * CHARS_PER_TOKEN;
  const value = String(text || '').trim();
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function normalizeMessages(messages = []) {
  return messages
    .filter(message => message && (message.role === 'user' || message.role === 'assistant'))
    .map(message => ({
      role: message.role,
      content: String(message.content || '').trim(),
      channel: message.channel || 'chat',
    }))
    .filter(message => message.content);
}

function transcript(messages) {
  return messages
    .map(message => `${message.role === 'user' ? 'User' : 'Cal'}: ${message.content}`)
    .join('\n\n');
}

function splitRecent(messages, recentTokenBudget) {
  const recent = [];
  let used = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const cost = estimateTokens(`${message.role}: ${message.content}`);
    if (recent.length > 0 && used + cost > recentTokenBudget) break;
    recent.unshift(message);
    used += cost;
  }

  return {
    older: messages.slice(0, messages.length - recent.length),
    recent,
  };
}

function cacheKey(sessionId, messages, summaryTokenBudget) {
  const digest = createHash('sha256')
    .update(JSON.stringify(messages))
    .digest('hex');
  return `${sessionId || 'default'}:${summaryTokenBudget}:${digest}`;
}

export async function generateConversationContext({
  sessionId,
  messages,
  summarize,
  maxTokens = positiveInteger(process.env.CAL_VOICE_CONTEXT_MAX_TOKENS, DEFAULT_MAX_TOKENS),
  recentTokens = positiveInteger(process.env.CAL_VOICE_CONTEXT_RECENT_TOKENS, DEFAULT_RECENT_TOKENS),
  summaryTokens = positiveInteger(process.env.CAL_VOICE_CONTEXT_SUMMARY_TOKENS, DEFAULT_SUMMARY_TOKENS),
} = {}) {
  const normalized = normalizeMessages(messages);
  const boundedRecentTokens = Math.min(recentTokens, maxTokens);
  const boundedSummaryTokens = Math.min(summaryTokens, Math.max(0, maxTokens - boundedRecentTokens));
  const { older, recent } = splitRecent(normalized, boundedRecentTokens);
  let earlierSummary = '';

  if (older.length && boundedSummaryTokens > 0) {
    const key = cacheKey(sessionId, older, boundedSummaryTokens);
    earlierSummary = summaryCache.get(key) || '';
    if (!earlierSummary && typeof summarize === 'function') {
      try {
        earlierSummary = clipToTokens(
          await summarize(transcript(older), boundedSummaryTokens),
          boundedSummaryTokens,
        );
        if (earlierSummary) summaryCache.set(key, earlierSummary);
      } catch (error) {
        console.warn(`[ConversationContext] Summary generation failed: ${error.message}`);
      }
    }

    // Voice remains usable during a transient summarizer failure. This is an
    // extractive fallback, not an additional durable memory surface.
    if (!earlierSummary) {
      earlierSummary = clipToTokens(transcript(older), boundedSummaryTokens);
    }
  }

  return {
    earlierSummary,
    recentMessages: recent,
  };
}

export function formatConversationContext(context = {}) {
  const parts = [];
  if (context.earlierSummary) {
    parts.push(`Earlier conversation summary:\n${context.earlierSummary}`);
  }
  if (Array.isArray(context.recentMessages) && context.recentMessages.length) {
    parts.push(`Recent conversation (verbatim):\n${transcript(context.recentMessages)}`);
  }
  return parts.join('\n\n');
}

export function __clearConversationContextCacheForTest() {
  summaryCache.clear();
}
