/**
 * Centralized path constants for Cal Gateway
 *
 * All paths are derived from CAL_HOME, which is either:
 * 1. Set via CAL_HOME environment variable (for non-standard setups)
 * 2. Auto-detected from this file's location (src/paths.js → distribution root)
 *
 * This makes the codebase portable — no hardcoded user paths.
 */

import path from 'path';
import { fileURLToPath } from 'url';

// Get this file's directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// CAL_HOME: root of the Cal distribution workspace
// Auto-detect: src → distribution root (go up 1 level)
export const CAL_HOME = process.env.CAL_HOME || path.resolve(__dirname, '..');

// Cal Gateway paths
export const GATEWAY_DIR = CAL_HOME;
export const DATA_DIR = path.join(GATEWAY_DIR, 'data');
export const CONFIG_DIR = path.join(GATEWAY_DIR, 'config');

// Harness paths (outside cal-gateway)
export const MEMORY_DIR = path.join(CAL_HOME, 'memory');
export const CONTEXT_DIR = path.join(CAL_HOME, 'context');
export const DOCS_DIR = path.join(CAL_HOME, 'docs');
export const SCRIPTS_DIR = path.join(CAL_HOME, 'scripts');
export const SKILLS_DIR = path.join(CAL_HOME, 'skills');

// Commonly used file paths
export const MEMORY_FILE = path.join(CONTEXT_DIR, 'MEMORY.md');
export const USER_FILE = path.join(CONTEXT_DIR, 'USER.md');
export const ACTION_ITEMS_FILE = path.join(CONTEXT_DIR, 'ACTION-ITEMS.md');

// Helper: get today's daily log path
export function getDailyLogPath(date = new Date()) {
  const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
  return path.join(MEMORY_DIR, `${dateStr}.md`);
}

// Helper: expand {{CAL_HOME}} placeholders in strings
export function expandPathPlaceholders(str) {
  return str.replace(/\{\{CAL_HOME\}\}/g, CAL_HOME);
}
