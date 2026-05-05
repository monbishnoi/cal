/**
 * User Configuration Loader for Cal Gateway
 *
 * Centralizes all user-specific settings:
 * - User identity (name, timezone)
 * - Channel configs (Telegram chat ID, iMessage sender)
 * - Personalization (greetings, job customizations)
 *
 * Values can be overridden by environment variables:
 * - CAL_USER_NAME
 * - CAL_USER_EMAIL
 * - CAL_TIMEZONE
 * - CAL_TELEGRAM_CHAT_ID
 * - CAL_IMESSAGE_ENABLED
 * - CAL_IMESSAGE_SENDER
 * - CAL_IMESSAGE_IDENTITY
 * - CAL_IMESSAGE_CHAT_ID
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'config', 'user.json');

// Cached config
let userConfig = null;

/**
 * Load user configuration from file with env var overrides
 */
function loadConfig() {
  if (userConfig) {
    return userConfig;
  }

  // Default config (works without user.json)
  let config = {
    name: 'User',
    email: null,
    timezone: 'UTC',
    locale: 'en-US',
    greeting: 'Hello!',
    sessionPrefix: 'user',
    assistant: {
      name: 'Cal',
      description: 'AI assistant',
    },
    telegram: {
      enabled: false,
      chatId: null,
    },
    imessage: {
      enabled: false,
      allowedSender: null,
      calIdentity: null,
      watchChatId: null,
      service: 'imessage',
    },
    jobs: {},
  };

  // Load from file if exists
  if (existsSync(CONFIG_PATH)) {
    try {
      const fileConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
      config = deepMerge(config, fileConfig);
      console.log(`[UserConfig] Loaded config for: ${config.name}`);
    } catch (err) {
      console.error('[UserConfig] Failed to load config:', err.message);
    }
  } else {
    console.warn('[UserConfig] No user.json found, using defaults');
  }

  // Apply environment variable overrides
  if (process.env.CAL_USER_NAME) {
    config.name = process.env.CAL_USER_NAME;
  }
  if (process.env.CAL_USER_EMAIL || process.env.USER_EMAIL) {
    config.email = process.env.CAL_USER_EMAIL || process.env.USER_EMAIL;
  }
  if (process.env.CAL_TIMEZONE) {
    config.timezone = process.env.CAL_TIMEZONE;
  }
  if (process.env.CAL_TELEGRAM_ENABLED) {
    config.telegram.enabled = process.env.CAL_TELEGRAM_ENABLED === 'true';
  }
  if (process.env.CAL_TELEGRAM_CHAT_ID) {
    config.telegram.chatId = process.env.CAL_TELEGRAM_CHAT_ID;
  }
  if (process.env.CAL_IMESSAGE_ENABLED) {
    config.imessage.enabled = process.env.CAL_IMESSAGE_ENABLED === 'true';
  }
  if (process.env.CAL_IMESSAGE_SENDER) {
    config.imessage.allowedSender = process.env.CAL_IMESSAGE_SENDER;
  }
  if (process.env.CAL_IMESSAGE_IDENTITY) {
    config.imessage.calIdentity = process.env.CAL_IMESSAGE_IDENTITY;
  }
  if (process.env.CAL_IMESSAGE_CHAT_ID) {
    config.imessage.watchChatId = process.env.CAL_IMESSAGE_CHAT_ID;
  }

  // Expand {{name}} in greeting
  if (config.greeting) {
    config.greeting = config.greeting.replace(/\{\{name\}\}/g, config.name);
  }

  userConfig = config;
  return config;
}

/**
 * Deep merge two objects
 */
function deepMerge(target, source) {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }

  return result;
}

/**
 * Get full user config
 */
export function getUserConfig() {
  return loadConfig();
}

/**
 * Get user's name
 */
export function getUserName() {
  return loadConfig().name;
}

/**
 * Get user's email, if configured
 */
export function getUserEmail() {
  return loadConfig().email;
}

/**
 * Get user's timezone
 */
export function getTimezone() {
  return loadConfig().timezone;
}

/**
 * Get user's locale
 */
export function getLocale() {
  return loadConfig().locale;
}

/**
 * Get greeting message
 */
export function getGreeting() {
  return loadConfig().greeting;
}

/**
 * Get session ID prefix (used to construct session IDs)
 */
export function getSessionPrefix() {
  return loadConfig().sessionPrefix;
}

/**
 * Get main session ID
 */
export function getMainSessionId() {
  return `${loadConfig().sessionPrefix}-main`;
}

/**
 * Get background session ID
 */
export function getBackgroundSessionId() {
  return `${loadConfig().sessionPrefix}-background`;
}

/**
 * Get assistant config
 */
export function getAssistantConfig() {
  return loadConfig().assistant;
}

/**
 * Get Telegram config
 */
export function getTelegramConfig() {
  return loadConfig().telegram;
}

/**
 * Get iMessage config
 */
export function getIMessageConfig() {
  return loadConfig().imessage;
}

/**
 * Get job-specific customizations
 */
export function getJobConfig(jobId) {
  return loadConfig().jobs?.[jobId] || {};
}

/**
 * Expand user placeholders in a string
 * Supports: {{USER_NAME}}, {{USER_EMAIL}}, {{TIMEZONE}}, {{ASSISTANT_NAME}}
 */
export function expandUserPlaceholders(str) {
  const config = loadConfig();

  return str
    .replace(/\{\{USER_NAME\}\}/g, config.name)
    .replace(/\{\{USER_EMAIL\}\}/g, config.email || '')
    .replace(/\{\{TIMEZONE\}\}/g, config.timezone)
    .replace(/\{\{ASSISTANT_NAME\}\}/g, config.assistant.name);
}

/**
 * Reload config from disk (clear cache)
 */
export function reloadUserConfig() {
  userConfig = null;
  return loadConfig();
}
