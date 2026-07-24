/**
 * Unified command handler for all channels.
 * Returns { response } if the message is a command, or null to pass through to Claude.
 */

import { execSync } from 'child_process';
import { getSkillNames } from './skills.js';
import { handleCodexNotificationPolicyInput } from './codex-notification-policy.js';

function isCommandAvailable(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

/**
 * @param {string} text - raw user message
 * @param {object} session - CalSession instance
 * @returns {{ response: string, action?: string } | null}
 */
export function handleCommand(text, session) {
  const cmd = text.trim().toLowerCase();
  const codexPolicyResult = handleCodexNotificationPolicyInput(text);

  if (codexPolicyResult) {
    return { response: codexPolicyResult.message };
  }

  if (cmd === '/reset') {
    session.reset();
    return { response: 'Session reset. Starting fresh!' };
  }

  if (cmd === '/status') {
    const usage = session.getUsageStatus();
    const response = [
      'Cal Gateway',
      `Session: ${session.sessionId}`,
      `Messages: ${session.messages.length}`,
      `Context: ${usage.percentageFormatted} (${usage.totalTokens.toLocaleString()}/${usage.contextLimit.toLocaleString()} tokens)`,
      `Skills: ${getSkillNames().join(', ')}`,
    ].join('\n');
    return { response };
  }

  if (cmd === '/restart') {
    if (!isCommandAvailable('pm2')) {
      return { response: 'pm2 not installed. Cannot restart automatically.' };
    }
    setTimeout(() => {
      try { execSync('pm2 restart cal-gateway'); } catch {}
    }, 1000);
    return { response: 'Restarting Cal Gateway... See you in a moment!' };
  }

  return null;
}
