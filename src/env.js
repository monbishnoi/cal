/**
 * Lightweight environment loader for config/.env.
 *
 * Keeps public distribution dependency-light while still supporting the usual
 * copy config/.env.template to config/.env setup flow.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { CAL_HOME } from './paths.js';

const ENV_FILE = join(CAL_HOME, 'config', '.env');

export function loadEnvFile(path = ENV_FILE) {
  if (!existsSync(path)) {
    return false;
  }

  const content = readFileSync(path, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return true;
}

loadEnvFile();
