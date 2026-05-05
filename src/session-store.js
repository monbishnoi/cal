/**
 * SessionStore - Persists sessions to disk for crash recovery
 *
 * Adapted from cal-server/src/session-store.js for Cal Gateway.
 * Sessions are saved to a JSON file after each message exchange.
 * On daemon restart, sessions are restored from disk.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const SESSIONS_FILE = join(DATA_DIR, 'sessions.json');

// In-memory cache of session data
let sessionsCache = new Map();

/**
 * Initialize the session store
 */
export function initSessionStore() {
  // Ensure data directory exists
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
    console.log(`[SessionStore] Created data directory: ${DATA_DIR}`);
  }

  // Load existing sessions from disk
  if (existsSync(SESSIONS_FILE)) {
    try {
      const data = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'));

      // Convert to Map and filter expired sessions
      const now = Date.now();
      let loaded = 0;
      let expired = 0;

      for (const [sessionId, session] of Object.entries(data)) {
        // Sessions expire after 24 hours of inactivity
        const lastActivity = session.lastActivity || 0;
        const age = now - lastActivity;
        const maxAge = 24 * 60 * 60 * 1000; // 24 hours

        if (age < maxAge) {
          sessionsCache.set(sessionId, session);
          loaded++;
        } else {
          expired++;
        }
      }

      console.log(`[SessionStore] Loaded ${loaded} session(s), expired ${expired}`);
    } catch (err) {
      console.error(`[SessionStore] Failed to load sessions:`, err.message);
      sessionsCache = new Map();
    }
  } else {
    console.log(`[SessionStore] No existing sessions file`);
  }
}

/**
 * Save all sessions to disk
 */
function saveToDisk() {
  try {
    const data = Object.fromEntries(sessionsCache);
    writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`[SessionStore] Failed to save sessions:`, err.message);
  }
}

/**
 * Get session data from store
 * @param {string} sessionId
 * @returns {object|null} Session data or null if not found
 */
export function getSession(sessionId) {
  return sessionsCache.get(sessionId) || null;
}

/**
 * Save session data to store
 * @param {string} sessionId
 * @param {object} sessionData - { messages, systemPrompt, lastActivity }
 */
export function saveSession(sessionId, sessionData) {
  sessionsCache.set(sessionId, {
    ...sessionData,
    lastActivity: Date.now(),
  });

  // Debounce disk writes (save at most every 2 seconds)
  if (!saveSession._timeout) {
    saveSession._timeout = setTimeout(() => {
      saveToDisk();
      saveSession._timeout = null;
    }, 2000);
  }
}

/**
 * Delete a session from store
 * @param {string} sessionId
 */
export function deleteSession(sessionId) {
  sessionsCache.delete(sessionId);
  saveToDisk();
}

/**
 * Get all session IDs
 * @returns {string[]}
 */
export function getAllSessionIds() {
  return Array.from(sessionsCache.keys());
}

/**
 * Force immediate save (for graceful shutdown)
 */
export function flushToDisk() {
  if (saveSession._timeout) {
    clearTimeout(saveSession._timeout);
    saveSession._timeout = null;
  }
  saveToDisk();
  console.log(`[SessionStore] Flushed ${sessionsCache.size} session(s) to disk`);
}
