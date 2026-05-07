/**
 * Lightweight append-only runtime event log.
 *
 * This is an audit/debug log, not the canonical session store. Conversation
 * history remains owned by CalSession/session-store.
 */

import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const EVENTS_FILE = process.env.CAL_EVENTS_FILE || join(DATA_DIR, 'events.jsonl');

export function appendEvent(event) {
  try {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    appendFileSync(EVENTS_FILE, JSON.stringify(event) + '\n', 'utf8');
  } catch (err) {
    console.error('[EventLog] Failed to append event:', err.message);
  }
}

export function getEventsFilePath() {
  return EVENTS_FILE;
}
