/**
 * Telegram Bot for Cal Gateway
 *
 * Handles incoming Telegram messages and routes them through CalSession.
 * Supports skills loaded from .claude/skills/ directory.
 * Integrates Session Bridge for automatic context preservation.
 *
 * Session is owned by gateway.js and passed via setSession().
 */

import { Telegraf } from 'telegraf';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadSkills, getSkillPrompt, getSkillNames, hasSkill, getSkillExecutionOptions } from './skills.js';
import { CAL_HOME } from './paths.js';
import { getTelegramConfig, getGreeting } from './user-config.js';
import { conversationRuntime } from './conversation-runtime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(CAL_HOME, 'telegram-bot/.env');

let bot = null;
let botRunning = false;
let session = null;  // Set by gateway via setSession()

/**
 * Load Telegram bot token from .env
 */
function loadBotToken() {
  if (!existsSync(ENV_PATH)) {
    throw new Error(`Telegram .env not found: ${ENV_PATH}`);
  }

  const envContent = readFileSync(ENV_PATH, 'utf8');
  for (const line of envContent.split('\n')) {
    if (line.startsWith('TELEGRAM_BOT_TOKEN=')) {
      return line.split('=')[1].trim();
    }
  }

  throw new Error('TELEGRAM_BOT_TOKEN not found in .env');
}

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
 * Initialize and start Telegram bot
 */
export async function startTelegram() {
  const token = loadBotToken();

  // Increase handler timeout from default 90s to 5 minutes
  // Complex Claude API calls (e.g., writing large markdown files) can exceed 90s
  bot = new Telegraf(token, {
    handlerTimeout: 5 * 60 * 1000,  // 5 minutes
  });
  botRunning = false;

  console.log('[Telegram] Starting bot...');

  // Middleware: Restrict to allowed user
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id?.toString();
    const allowedChatId = getTelegramConfig().chatId;

    if (!allowedChatId) {
      console.log(`[Telegram] No allowed chat ID configured, rejecting ${chatId}`);
      return ctx.reply('Bot not configured. Set telegram.chatId in config/user.json');
    }

    if (chatId !== allowedChatId) {
      console.log(`[Telegram] Unauthorized access attempt from ${chatId}`);
      return ctx.reply('Sorry, this bot is private.');
    }
    return next();
  });

  // Commands
  bot.command('start', (ctx) => {
    ctx.reply(`${getGreeting()} Cal Gateway is ready. Just send me a message.`);
  });

  bot.command('help', (ctx) => {
    const skills = getSkillNames();
    const skillList = skills.length > 0
      ? skills.map(s => `/${s}`).join(', ')
      : 'None loaded';

    ctx.reply(
      '*Cal Gateway Commands*\n\n' +
      '*Built-in:*\n' +
      '/reset - Clear conversation history\n' +
      '/restart - Restart Gateway (via pm2)\n' +
      '/status - Show session info\n' +
      '/skills - List available skills\n' +
      '/help - Show this message\n\n' +
      `*Skills:* ${skillList}`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('skills', (ctx) => {
    const skills = loadSkills();

    if (skills.size === 0) {
      ctx.reply('No skills loaded.');
      return;
    }

    let message = '*Available Skills*\n\n';
    for (const [name, skill] of skills) {
      message += `*/${name}*\n${skill.description || 'No description'}\n\n`;
    }

    ctx.reply(message, { parse_mode: 'Markdown' });
  });

  const runBuiltinCommand = async (ctx, text) => {
    try {
      const result = await conversationRuntime.handleUserMessage({
        source: 'telegram',
        text,
        session: getSession(),
      });
      await ctx.reply(result.text);
    } catch (err) {
      console.error(`[Telegram] Command error (${text}):`, err.message);
      await ctx.reply(`Sorry, command ${text} failed: ${err.message}`);
    }
  };

  bot.command('reset', (ctx) => runBuiltinCommand(ctx, '/reset'));
  bot.command('restart', (ctx) => runBuiltinCommand(ctx, '/restart'));
  bot.command('status', (ctx) => runBuiltinCommand(ctx, '/status'));

  // Skill handler - catches any /command and checks if it's a skill
  bot.use(async (ctx, next) => {
    const message = ctx.message?.text;

    // Check if it's a command (starts with /)
    if (!message || !message.startsWith('/')) {
      return next();
    }

    // Extract command name (without the /)
    const commandMatch = message.match(/^\/(\w+)/);
    if (!commandMatch) {
      return next();
    }

    const commandName = commandMatch[1];

    // Skip built-in commands (already handled above)
    const builtInCommands = ['start', 'help', 'reset', 'restart', 'status', 'skills'];
    if (builtInCommands.includes(commandName)) {
      return next();
    }

    // Check if it's a skill
    if (!hasSkill(commandName)) {
      // Not a skill, pass to next handler (will be treated as regular message)
      return next();
    }

    // It's a skill! Execute it
    console.log(`[Telegram] Invoking skill: ${commandName}`);

    ctx.sendChatAction('typing');

    let typingInterval = null;
    try {
      const s = getSession();
      const skillPrompt = getSkillPrompt(commandName);
      const skillOptions = getSkillExecutionOptions(commandName);

      // Keep typing indicator alive
      typingInterval = setInterval(() => {
        ctx.sendChatAction('typing').catch(() => {});
      }, 4000);

      const result = await conversationRuntime.handleUserMessage({
        source: 'telegram',
        text: skillPrompt,
        session: s,
        handleCommands: false,
        sessionOptions: {
          onToolCall: (name) => {
            console.log(`[Telegram] Skill tool call: ${name}`);
          },
          ...skillOptions,
        },
      });

      await sendLongMessage(ctx, result.text);

    } catch (err) {
      console.error(`[Telegram] Skill error (${commandName}):`, err.message);
      ctx.reply(`Sorry, skill /${commandName} failed: ${err.message}`);
    } finally {
      if (typingInterval) clearInterval(typingInterval);
    }
  });

  // Handle text messages
  bot.on('text', async (ctx) => {
    const message = ctx.message.text;
    const chatId = ctx.chat.id;

    console.log(`[Telegram] Message from ${chatId}: ${message.substring(0, 50)}...`);

    // Send "typing" indicator
    ctx.sendChatAction('typing');

    let typingInterval = null;
    try {
      // Get shared session and send message
      const s = getSession();

      // Keep typing indicator alive during processing
      typingInterval = setInterval(() => {
        ctx.sendChatAction('typing').catch(() => {});
      }, 4000);

      const result = await conversationRuntime.handleUserMessage({
        source: 'telegram',
        text: message,
        session: s,
        sessionOptions: {
          onToolCall: (name) => {
            console.log(`[Telegram] Tool call: ${name}`);
          },
        },
      });

      // Send response (split if too long)
      await sendLongMessage(ctx, result.text);

    } catch (err) {
      console.error('[Telegram] Error:', err.message);
      ctx.reply(`Sorry, something went wrong: ${err.message}`);
    } finally {
      if (typingInterval) clearInterval(typingInterval);
    }
  });

  // Error handling
  bot.catch((err, ctx) => {
    console.error('[Telegram] Bot error:', err);
  });

  // Start polling (drop pending updates to avoid reprocessing old messages on restart)
  await bot.launch({ dropPendingUpdates: true });
  botRunning = true;
  console.log('[Telegram] Bot started successfully');

  return bot;
}

/**
 * Send a long message, splitting into chunks if needed
 */
async function sendLongMessage(ctx, text, parseMode = 'Markdown') {
  const MAX_LENGTH = 4096;

  if (text.length <= MAX_LENGTH) {
    try {
      await ctx.reply(text, { parse_mode: parseMode });
    } catch (err) {
      // If Markdown fails, try plain text
      if (err.message.includes('parse')) {
        await ctx.reply(text);
      } else {
        throw err;
      }
    }
    return;
  }

  // Split into chunks
  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Find a good split point (newline or space)
    let splitAt = remaining.lastIndexOf('\n', MAX_LENGTH);
    if (splitAt < MAX_LENGTH / 2) {
      splitAt = remaining.lastIndexOf(' ', MAX_LENGTH);
    }
    if (splitAt < MAX_LENGTH / 2) {
      splitAt = MAX_LENGTH;
    }

    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trim();
  }

  // Send chunks
  for (const chunk of chunks) {
    try {
      await ctx.reply(chunk, { parse_mode: parseMode });
    } catch (err) {
      if (err.message.includes('parse')) {
        await ctx.reply(chunk);
      }
    }
    // Small delay between chunks
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/**
 * Send a proactive message (for scheduled jobs)
 */
export async function sendMessage(text) {
  if (!bot) {
    throw new Error('Telegram bot not started');
  }

  console.log(`[Telegram] Sending proactive message (${text.length} chars)`);

  try {
    // Split if needed
    const MAX_LENGTH = 4096;

    if (text.length <= MAX_LENGTH) {
      await bot.telegram.sendMessage(getTelegramConfig().chatId, text, { parse_mode: 'Markdown' });
    } else {
      // Split into chunks
      let remaining = text;
      while (remaining.length > 0) {
        const chunk = remaining.substring(0, MAX_LENGTH);
        remaining = remaining.substring(MAX_LENGTH);

        try {
          await bot.telegram.sendMessage(getTelegramConfig().chatId, chunk, { parse_mode: 'Markdown' });
        } catch (err) {
          if (err.message.includes('parse')) {
            await bot.telegram.sendMessage(getTelegramConfig().chatId, chunk);
          }
        }

        if (remaining.length > 0) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    }

    return true;
  } catch (err) {
    console.error('[Telegram] Failed to send message:', err.message);

    // Retry without Markdown
    try {
      await bot.telegram.sendMessage(getTelegramConfig().chatId, text);
      return true;
    } catch (retryErr) {
      console.error('[Telegram] Retry failed:', retryErr.message);
      return false;
    }
  }
}

/**
 * Stop Telegram bot
 */
export function stopTelegram() {
  if (bot) {
    console.log('[Telegram] Stopping bot...');
    if (botRunning) {
      try {
        bot.stop('Gateway shutdown');
      } catch (err) {
        if (!err.message?.includes('not running')) {
          throw err;
        }
      }
    }
    botRunning = false;
    bot = null;
  }
}
