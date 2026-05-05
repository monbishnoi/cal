/**
 * Output Router for Cal Gateway
 *
 * Routes job output to the appropriate destination:
 * - file: Write to a file
 * - telegram: Send to the configured Telegram chat
 * - console: Just log (for testing)
 *
 * Other channel-specific output is handled by those modules.
 */

import { writeFileSync, appendFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { mkdirSync } from 'fs';
import { CAL_HOME } from './paths.js';
import { getTimezone, getLocale } from './user-config.js';

/**
 * Route output based on job configuration
 *
 * @param {Object} job - Job configuration
 * @param {string} content - Content to output
 */
export async function routeOutput(job, content) {
  const output = job.output || 'console';

  switch (output) {
    case 'file':
      return writeToFile(job.outputPath, content);

    case 'telegram':
      return sendToTelegram(content);

    case 'console':
    default:
      console.log(`[Output] ${job.id}:\n${content}`);
      return true;
  }
}

async function sendToTelegram(content) {
  const telegram = await import('./telegram.js');
  return telegram.sendMessage(content);
}

/**
 * Write content to a file
 */
function writeToFile(path, content) {
  // Replace YYYY-MM-DD with today's date
  const today = new Date().toLocaleDateString('en-CA', { timeZone: getTimezone() });
  const resolvedPath = path.replace('YYYY-MM-DD', today);

  const fullPath = resolvedPath.startsWith('/') ? resolvedPath : join(CAL_HOME, resolvedPath);
  console.log(`[Output] Writing to file: ${fullPath}`);

  // Ensure directory exists
  const dir = dirname(fullPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Append with timestamp
  const timestamp = new Date().toLocaleString(getLocale(), { timeZone: getTimezone() });
  const entry = `\n---\n## ${timestamp}\n\n${content}\n`;

  if (existsSync(fullPath)) {
    appendFileSync(fullPath, entry, 'utf8');
  } else {
    writeFileSync(fullPath, `# Job Output Log\n${entry}`, 'utf8');
  }

  console.log('[Output] File written successfully');
  return true;
}
