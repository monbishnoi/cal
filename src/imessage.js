/**
 * iMessage Channel for Cal Gateway
 *
 * Handles incoming iMessages and routes them through CalSession.
 * Uses imsg CLI to read from Messages database and send via AppleScript.
 * Same shared session as Telegram, PWA, and scheduled jobs.
 * Integrates Session Bridge for automatic context preservation.
 *
 * Session is owned by gateway.js and passed via setSession().
 *
 * Setup:
 * 1. Install imsg: brew install imsg
 * 2. Grant Full Disk Access to the imsg binary and node binary
 * 3. Configure config/user.json with your iMessage settings
 * 4. On Mac Messages app: enable only Cal's identity (email or phone)
 * 5. On iPhone Messages: disable Cal's identity, keep your phone number
 *
 * Architecture: imsg watch (polls chat.db) -> new message -> CalSession -> response -> imsg send
 */

import { spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadSkills, getSkillPrompt, getSkillNames, hasSkill, getSkillExecutionOptions } from './skills.js';
import { getIMessageConfig } from './user-config.js';
import { conversationRuntime } from './conversation-runtime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '../config/imessage.json');
const IMSG_PATH = '/opt/homebrew/bin/imsg';

// Session (set by gateway via setSession())
let session = null;

// Configuration (loaded from user config or legacy file)
let config = {
  enabled: false,
  allowedSender: '',
  calIdentity: '',
  watchChatId: '',
  service: 'imessage'
};

let watchProcess = null;
let isRunning = false;

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
 * Load configuration from user config (preferred) or legacy config/imessage.json
 */
function loadConfig() {
  // First try centralized user config
  const userImessageConfig = getIMessageConfig();

  if (userImessageConfig && userImessageConfig.allowedSender) {
    config = { ...config, ...userImessageConfig };
    console.log('[iMessage] Loaded config from user.json');
    return true;
  }

  // Fall back to legacy config file
  if (!existsSync(CONFIG_PATH)) {
    console.log('[iMessage] No config found (neither user.json nor config/imessage.json)');
    return false;
  }

  try {
    const content = readFileSync(CONFIG_PATH, 'utf8');
    const loaded = JSON.parse(content);
    config = { ...config, ...loaded };
    console.log('[iMessage] Loaded config from legacy imessage.json');
    return true;
  } catch (err) {
    console.error('[iMessage] Failed to load config:', err.message);
    return false;
  }
}

/**
 * Initialize and start iMessage watcher
 */
export async function startIMessage() {
  // Load config from file
  if (!loadConfig()) {
    return null;
  }

  if (!config.enabled) {
    console.log('[iMessage] Disabled in config');
    return null;
  }

  if (!config.allowedSender) {
    console.error('[iMessage] allowedSender not set in config — cannot start');
    return null;
  }

  if (!config.watchChatId) {
    console.error('[iMessage] watchChatId not set — run: imsg chats --limit 20 --json to find it');
    return null;
  }

  console.log('[iMessage] Starting watcher...');
  console.log(`[iMessage] Watching chat ID: ${config.watchChatId}`);
  console.log(`[iMessage] Allowed sender: ${config.allowedSender}`);
  if (config.calIdentity) {
    console.log(`[iMessage] Cal identity: ${config.calIdentity}`);
  }

  // Load skills
  await loadSkills();
  console.log(`[iMessage] Skills loaded: ${getSkillNames().join(', ')}`);

  // Start watching for new messages
  startWatching();

  return true;
}

/**
 * Start the imsg watch process
 */
function startWatching() {
  if (watchProcess) {
    watchProcess.kill();
  }

  isRunning = true;

  // Spawn imsg watch as a child process
  watchProcess = spawn(IMSG_PATH, [
    'watch',
    '--chat-id', config.watchChatId,
    '--json',
    '--debounce', '500ms'
  ], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let buffer = '';

  watchProcess.stdout.on('data', (data) => {
    buffer += data.toString();

    // Process complete JSON lines
    const lines = buffer.split('\n');
    buffer = lines.pop(); // Keep incomplete line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const message = JSON.parse(trimmed);
        handleIncoming(message);
      } catch (err) {
        // Not valid JSON — might be a partial line or error message
        console.log(`[iMessage] Non-JSON output: ${trimmed.substring(0, 100)}`);
      }
    }
  });

  watchProcess.stderr.on('data', (data) => {
    const err = data.toString().trim();
    if (err) {
      console.error(`[iMessage] Watch stderr: ${err}`);
    }
  });

  watchProcess.on('close', (code) => {
    console.log(`[iMessage] Watch process exited with code ${code}`);
    if (isRunning) {
      // Auto-restart after a delay
      console.log('[iMessage] Restarting watcher in 5 seconds...');
      setTimeout(() => {
        if (isRunning) startWatching();
      }, 5000);
    }
  });

  watchProcess.on('error', (err) => {
    console.error(`[iMessage] Watch process error: ${err.message}`);
  });

  console.log('[iMessage] Watcher started');
}

/**
 * Handle an incoming iMessage
 */
async function handleIncoming(message) {
  // Debug: Log every message the watcher receives
  console.log(`[iMessage] Raw message: is_from_me=${message.is_from_me}, sender=${message.sender}, dest=${message.destination_caller_id}, text="${(message.text || '').substring(0, 30)}..."`);

  // Skip messages sent from this Mac (Cal's own responses)
  if (message.is_from_me === true) {
    return;
  }

  // Check if sender matches allowed sender
  const sender = message.sender || '';
  const normalizedSender = sender.replace(/[^0-9+@.]/g, '').toLowerCase();
  const normalizedAllowed = config.allowedSender.replace(/[^0-9+@.]/g, '').toLowerCase();

  // Phone number comparison — match last 10 digits
  const isPhone = normalizedAllowed.match(/^\+?\d+$/);
  let senderAllowed = false;

  if (isPhone) {
    senderAllowed = normalizedSender.includes(normalizedAllowed.slice(-10)) ||
                    normalizedAllowed.includes(normalizedSender.slice(-10));
  } else {
    senderAllowed = normalizedSender.includes(normalizedAllowed) ||
                    normalizedAllowed.includes(normalizedSender);
  }

  if (!senderAllowed) {
    console.log(`[iMessage] Ignoring message from unauthorized sender: ${sender}`);
    return;
  }

  const text = (message.text || message.body || '').trim();
  if (!text) return;

  console.log(`[iMessage] Received: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);

  try {
    // Check for skill triggers
    const skillMatch = text.match(/^\/([\w-]+)/);
    if (skillMatch) {
      const skillName = skillMatch[1].toLowerCase();
      if (hasSkill(skillName)) {
        const skillPrompt = getSkillPrompt(skillName);
        const skillOptions = getSkillExecutionOptions(skillName);
        const s = getSession();
        const result = await conversationRuntime.handleUserMessage({
          source: 'imessage',
          text: skillPrompt,
          session: s,
          handleCommands: false,
          sessionOptions: skillOptions,
        });

        await sendResponse(result.text);
        return;
      }
    }

    // Regular message — send to CalSession
    const s = getSession();

    const result = await conversationRuntime.handleUserMessage({
      source: 'imessage',
      text,
      session: s,
    });

    await sendResponse(result.text);

  } catch (err) {
    console.error('[iMessage] Error handling message:', err.message);
    await sendResponse(`Sorry, something went wrong: ${err.message}`);
  }
}

/**
 * Send a response via iMessage
 */
async function sendResponse(text) {
  if (!text) return;

  // iMessage has ~20K char soft limit, but let's be conservative
  const MAX_LENGTH = 10000;

  if (text.length <= MAX_LENGTH) {
    await sendImsg(text);
  } else {
    // Split into chunks
    const chunks = splitMessage(text, MAX_LENGTH);
    for (const chunk of chunks) {
      await sendImsg(chunk);
      // Small delay between chunks
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
}

/**
 * Send a single message via imsg CLI
 */
function sendImsg(text) {
  return new Promise((resolve, reject) => {
    // Use --chat-id to send to the specific chat thread
    // This ensures the response goes to the same conversation where the user messaged Cal
    const args = [
      'send',
      '--chat-id', config.watchChatId,
      '--text', text
    ];

    const proc = spawn(IMSG_PATH, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderr = '';

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        console.log(`[iMessage] Sent response (${text.length} chars)`);
        resolve();
      } else {
        console.error(`[iMessage] Send failed (code ${code}): ${stderr}`);
        reject(new Error(`imsg send failed: ${stderr}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Send a proactive message (for scheduled jobs)
 */
export async function sendMessage(text) {
  if (!config.enabled) {
    console.log('[iMessage] Cannot send — disabled');
    return false;
  }

  console.log(`[iMessage] Sending proactive message (${text.length} chars)`);

  try {
    await sendResponse(text);
    return true;
  } catch (err) {
    console.error('[iMessage] Failed to send proactive message:', err.message);
    return false;
  }
}

/**
 * Split a long message into chunks at natural boundaries
 */
function splitMessage(text, maxLength) {
  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Find a good split point
    let splitAt = remaining.lastIndexOf('\n\n', maxLength); // Paragraph break
    if (splitAt < maxLength / 2) {
      splitAt = remaining.lastIndexOf('\n', maxLength); // Line break
    }
    if (splitAt < maxLength / 2) {
      splitAt = remaining.lastIndexOf(' ', maxLength); // Space
    }
    if (splitAt < maxLength / 2) {
      splitAt = maxLength; // Hard cut
    }

    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trim();
  }

  return chunks;
}

/**
 * Stop iMessage watcher
 */
export function stopIMessage() {
  isRunning = false;
  if (watchProcess) {
    console.log('[iMessage] Stopping watcher...');
    watchProcess.kill();
    watchProcess = null;
  }
}
