/**
 * Platform and Environment Detection for Cal Gateway
 *
 * Provides utilities to detect:
 * - Platform (macOS, Linux, Windows)
 * - Command availability (qmd, pm2, icalBuddy, etc.)
 * - Feature availability based on environment
 *
 * Use these checks before calling platform-specific or optional commands
 * to provide graceful degradation and clear error messages.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';

// Cache for command availability (avoid repeated checks)
const commandCache = new Map();

/**
 * Check if running on macOS
 * @returns {boolean}
 */
export function isMacOS() {
  return process.platform === 'darwin';
}

/**
 * Check if running on Linux
 * @returns {boolean}
 */
export function isLinux() {
  return process.platform === 'linux';
}

/**
 * Check if running on Windows
 * @returns {boolean}
 */
export function isWindows() {
  return process.platform === 'win32';
}

/**
 * Get platform name for display
 * @returns {string}
 */
export function getPlatformName() {
  switch (process.platform) {
    case 'darwin': return 'macOS';
    case 'linux': return 'Linux';
    case 'win32': return 'Windows';
    default: return process.platform;
  }
}

/**
 * Check if a command is available in PATH
 * @param {string} command - Command name (e.g., 'qmd', 'pm2', 'icalBuddy')
 * @returns {boolean}
 */
export function isCommandAvailable(command) {
  // Check cache first
  if (commandCache.has(command)) {
    return commandCache.get(command);
  }

  let available = false;

  try {
    // Use 'which' on Unix, 'where' on Windows
    const checkCmd = isWindows() ? `where ${command}` : `which ${command}`;
    execSync(checkCmd, { stdio: 'pipe' });
    available = true;
  } catch {
    available = false;
  }

  // Cache the result
  commandCache.set(command, available);
  return available;
}

/**
 * Clear the command availability cache
 * Useful if tools are installed during a session
 */
export function clearCommandCache() {
  commandCache.clear();
}

/**
 * Check if a file/path exists
 * @param {string} filePath - Path to check
 * @returns {boolean}
 */
export function pathExists(filePath) {
  return existsSync(filePath);
}

/**
 * Get the path to a command, or null if not found
 * @param {string} command - Command name
 * @returns {string|null}
 */
export function getCommandPath(command) {
  try {
    const checkCmd = isWindows() ? `where ${command}` : `which ${command}`;
    const result = execSync(checkCmd, { encoding: 'utf8', stdio: 'pipe' });
    return result.trim().split('\n')[0]; // Return first match
  } catch {
    return null;
  }
}

/**
 * Known optional tools and their install instructions
 */
const OPTIONAL_TOOLS = {
  icalBuddy: {
    name: 'icalBuddy',
    description: 'Apple Calendar CLI',
    platform: 'macOS',
    install: 'brew install ical-buddy',
    required: false,
  },
  pm2: {
    name: 'pm2',
    description: 'Process manager for Node.js',
    platform: 'any',
    install: 'npm install -g pm2',
    required: false,
  },
  qmd: {
    name: 'qmd',
    description: 'Semantic search daemon',
    platform: 'any',
    install: 'See qmd setup documentation',
    required: false,
  },
  memo: {
    name: 'memo',
    description: 'Apple Notes CLI',
    platform: 'macOS',
    install: 'brew tap antoniorodr/memo && brew install antoniorodr/memo/memo',
    required: false,
  },
  imsg: {
    name: 'imsg',
    description: 'iMessage CLI',
    platform: 'macOS',
    install: 'brew install imsg',
    required: false,
  },
};

/**
 * Get install instructions for a tool
 * @param {string} tool - Tool name
 * @returns {string}
 */
export function getInstallInstructions(tool) {
  const info = OPTIONAL_TOOLS[tool];
  if (!info) {
    return `Install ${tool} to use this feature.`;
  }

  let message = `${info.name} not installed.`;
  if (info.platform !== 'any') {
    message += ` (${info.platform} only)`;
  }
  message += `\nInstall with: ${info.install}`;
  return message;
}

/**
 * Check if a Mac-only feature is available
 * Returns an error object if not available, null if OK
 * @param {string} feature - Feature name for error message
 * @param {string} [command] - Optional command to check
 * @returns {{error: string}|null}
 */
export function checkMacFeature(feature, command = null) {
  if (!isMacOS()) {
    return { error: `${feature} requires macOS. Current platform: ${getPlatformName()}` };
  }

  if (command && !isCommandAvailable(command)) {
    return { error: getInstallInstructions(command) };
  }

  return null;
}

/**
 * Check if an optional command is available
 * Returns an error object if not available, null if OK
 * @param {string} command - Command to check
 * @returns {{error: string}|null}
 */
export function checkCommand(command) {
  if (!isCommandAvailable(command)) {
    return { error: getInstallInstructions(command) };
  }
  return null;
}

/**
 * Get a summary of available features
 * @returns {object}
 */
export function getFeatureStatus() {
  return {
    platform: getPlatformName(),
    isMacOS: isMacOS(),
    tools: {
      icalBuddy: isCommandAvailable('icalBuddy'),
      pm2: isCommandAvailable('pm2'),
      qmd: isCommandAvailable('qmd'),
      memo: isCommandAvailable('memo'),
      imsg: isCommandAvailable('imsg'),
    },
  };
}
