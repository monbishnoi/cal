/**
 * Tools for Cal Gateway
 *
 * Tool definitions and execution for scheduled jobs and interactive sessions.
 * Includes: calendar, email, notes, file operations, web search, semantic search.
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { isFeatureEnabled, getFeatureConfig } from './features.js';
import { getMCPClientManager } from './mcp-client.js';
import { CAL_HOME, SCRIPTS_DIR } from './paths.js';
import { checkMacFeature, isMacOS, isCommandAvailable, getCommandPath } from './detect.js';

const execAsync = promisify(exec);

/**
 * Execute a command with guaranteed timeout.
 *
 * Unlike execSync's timeout (which can leave zombie processes), this:
 * 1. Uses spawn with explicit process management
 * 2. Kills the entire process tree on timeout
 * 3. Always returns a result (never hangs indefinitely)
 *
 * This is critical for AppleScript tools that can hang when apps are unresponsive.
 */
async function execWithGuaranteedTimeout(command, options = {}) {
  const timeout = options.timeout || 15000;
  const shell = options.shell || '/bin/bash';

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let killed = false;

    const child = spawn(shell, ['-c', command], {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
    });

    // Set up timeout
    const timer = setTimeout(() => {
      killed = true;
      // Kill entire process group
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (e) {
        // Process might already be dead
        child.kill('SIGKILL');
      }
      reject(new Error(`Command timed out after ${timeout}ms. The app may be unresponsive.`));
    }, timeout);

    // Detach child into its own process group so we can kill the whole tree
    try {
      process.kill(-child.pid, 0); // Check if process group exists
    } catch (e) {
      // Can't create process group, fall back to regular kill
    }

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return; // Already rejected by timeout

      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || `Command failed with exit code ${code}`));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (!killed) {
        reject(err);
      }
    });
  });
}

/**
 * Get tool definitions for Claude
 */
export function getTools(options = {}) {
  const { includeMCP = true } = options;
  const tools = [
    {
      name: 'bash',
      description: 'Execute bash commands. Use for running scripts, checking system state, etc.',
      input_schema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The bash command to execute',
          },
        },
        required: ['command'],
      },
    },
    {
      name: 'read_file',
      description: 'Read the contents of a file',
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path (relative to harness/ or absolute)',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'write_file',
      description: 'Write content to a file (creates or overwrites)',
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path (relative to harness/ or absolute)',
          },
          content: {
            type: 'string',
            description: 'Content to write',
          },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'edit_file',
      description: 'Edit a file by replacing old text with new text',
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path (relative to harness/ or absolute)',
          },
          old_text: {
            type: 'string',
            description: 'Text to find and replace',
          },
          new_text: {
            type: 'string',
            description: 'Replacement text',
          },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
    {
      name: 'read_calendar',
      description: 'Read calendar events from Apple Calendar',
      input_schema: {
        type: 'object',
        properties: {
          timeframe: {
            type: 'string',
            enum: ['today', 'tomorrow', 'week'],
            description: 'Timeframe to query',
          },
        },
        required: ['timeframe'],
      },
    },
    {
      name: 'write_calendar',
      description: 'Create a new calendar event in Apple Calendar',
      input_schema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Event title',
          },
          start: {
            type: 'string',
            description: 'Start time in format: YYYY-MM-DD HH:MM (e.g., 2026-03-22 14:00)',
          },
          end: {
            type: 'string',
            description: 'End time in format: YYYY-MM-DD HH:MM (e.g., 2026-03-22 15:00)',
          },
          calendar: {
            type: 'string',
            enum: ['Calendar', 'Home'],
            default: 'Calendar',
            description: 'Calendar to use. DEFAULT: "Calendar" for meetings and work events. Use "Home" or another configured calendar for personal events.',
          },
          location: {
            type: 'string',
            description: 'Optional location',
          },
          notes: {
            type: 'string',
            description: 'Optional notes/description',
          },
        },
        required: ['title', 'start', 'end', 'calendar'],
      },
    },
    {
      name: 'write_reminder',
      description: 'Create a new reminder in Apple Reminders',
      input_schema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Reminder title/text',
          },
          list: {
            type: 'string',
            default: 'Reminders',
            description: 'Reminders list name (check your list names in Reminders.app)',
          },
        },
        required: ['title'],
      },
    },
    {
      name: 'read_mail',
      description: 'Read emails from Apple Mail - list, search, or read specific messages',
      input_schema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            enum: ['count', 'unread', 'recent', 'search', 'read', 'summary'],
            description: 'Command: count (unread/total), unread (list unread), recent (list recent), search (by subject/sender), read (full message by ID), summary (brief unread)',
          },
          account: {
            type: 'string',
            description: 'Mail account name. Omit to use the first configured Apple Mail account.',
          },
          limit: {
            type: 'number',
            description: 'Limit number of results (default: 10)',
          },
          query: {
            type: 'string',
            description: 'Search query - for "search" command only',
          },
          message_id: {
            type: 'number',
            description: 'Message ID - for "read" command only',
          },
        },
        required: ['command'],
      },
    },
    {
      name: 'read_notes',
      description: 'Read Apple Notes via memo CLI - list notes, list folders, read a note, or search notes',
      input_schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'folders', 'read', 'search'],
            description: 'Action: list (all notes), folders (list folders), read (specific note by name), search (fuzzy search)',
          },
          note_name: {
            type: 'string',
            description: 'Name of note to read (required for "read" action)',
          },
          search_term: {
            type: 'string',
            description: 'Search term (required for "search" action)',
          },
          folder: {
            type: 'string',
            description: 'Optional folder to filter notes (for "list" action)',
          },
        },
        required: ['action'],
      },
    },
    {
      name: 'write_notes',
      description: 'Create, move, or delete Apple Notes',
      input_schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'move', 'delete'],
            description: 'Action: create (new note), move (to different folder), delete',
          },
          title: {
            type: 'string',
            description: 'Note title (required for create/move/delete)',
          },
          body: {
            type: 'string',
            description: 'Note content (for create action)',
          },
          folder: {
            type: 'string',
            description: 'Folder name. For create: destination folder (default: Notes). For move: target folder.',
          },
          source_folder: {
            type: 'string',
            description: 'Source folder for move action (default: searches all folders)',
          },
        },
        required: ['action', 'title'],
      },
    },
    {
      name: 'web_search',
      description: 'Search the web using Brave Search API',
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'share_file',
      description: 'Get a shareable OneDrive/SharePoint link for a local file. Use when user wants to share a file or asks for a link to a document. Works with any file synced via OneDrive (personal or team SharePoint).',
      input_schema: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: 'Filename or partial name to search for (e.g., "SDK requirements", "A2A protocol")',
          },
          exact: {
            type: 'boolean',
            description: 'If true, match exact filename. If false (default), fuzzy match.',
          },
        },
        required: ['filename'],
      },
    },
  ];

  // Conditionally add QMD semantic search if feature is enabled
  if (isFeatureEnabled('qmd')) {
    tools.push({
      name: 'semantic_search',
      description: 'Search Cal\'s knowledge base using QMD hybrid search. Combines keyword matching (BM25), semantic understanding (vectors), and LLM re-ranking. Use for: finding connections between topics, recalling context from memory, discovering related content even with different wording.',
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural language search query (e.g., "what connects my notes about QMD and mobile access")',
          },
          mode: {
            type: 'string',
            enum: ['hybrid', 'keyword', 'semantic'],
            description: 'Search mode: hybrid (default, best results), keyword (BM25 only, faster), semantic (vector only, conceptual)',
          },
          collection: {
            type: 'string',
            enum: ['all', 'memory', 'docs', 'context', 'cal-arch'],
            description: 'Collection to search: all (default), memory (daily logs), docs (projects), context (user profile), cal-arch (Cal architecture)',
          },
          limit: {
            type: 'number',
            description: 'Number of results to return (default: 5)',
          },
        },
        required: ['query'],
      },
    });
  }

  if (includeMCP) {
    tools.push(...getExternalMCPTools(tools.map(tool => tool.name)));
  }

  return tools;
}

const externalToolRoutes = new Map();

function normalizeToolName(name) {
  return String(name || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function normalizeServerName(serverName) {
  return normalizeToolName(serverName).replace(/-/g, '_');
}

function isSelfDescribingToolName(serverName, toolName) {
  const normalizedServer = normalizeServerName(serverName);
  const compactServer = normalizedServer.replace(/_/g, '');
  const normalizedTool = normalizeToolName(toolName);

  if (normalizedTool.startsWith(`${normalizedServer}_`) || normalizedTool.startsWith(`${compactServer}_`)) {
    return true;
  }

  if (serverName === 'qmd' && normalizedTool.startsWith('qmd_')) return true;

  return false;
}

function getExternalMCPTools(existingToolNames = []) {
  const mcpManager = getMCPClientManager();
  const externalTools = mcpManager.getAllTools();
  const usedNames = new Set(existingToolNames);
  const originalNameCounts = new Map();
  const toolDefinitions = [];

  externalToolRoutes.clear();

  for (const { tool } of externalTools) {
    const toolName = normalizeToolName(tool.name);
    originalNameCounts.set(toolName, (originalNameCounts.get(toolName) || 0) + 1);
  }

  for (const { serverName, tool } of externalTools) {
    const originalName = normalizeToolName(tool.name);
    const prefixedName = `${normalizeServerName(serverName)}_${originalName}`;

    const canUseOriginal =
      isSelfDescribingToolName(serverName, originalName) &&
      originalNameCounts.get(originalName) === 1 &&
      !usedNames.has(originalName);

    const exposedName = canUseOriginal ? originalName : prefixedName;

    if (usedNames.has(exposedName)) {
      console.warn(`[Tool:MCP] Skipping duplicate exposed tool name: ${exposedName}`);
      continue;
    }

    usedNames.add(exposedName);
    externalToolRoutes.set(exposedName, {
      serverName,
      originalName: tool.name,
    });

    toolDefinitions.push({
      name: exposedName,
      description: `[${serverName}] ${tool.description || tool.name}`,
      input_schema: tool.inputSchema || tool.input_schema || {
        type: 'object',
        properties: {},
      },
    });
  }

  return toolDefinitions;
}

function resolveExternalToolRoute(toolName) {
  if (externalToolRoutes.has(toolName)) {
    return externalToolRoutes.get(toolName);
  }

  // Rebuild route cache in case executeToolCall is invoked before getTools().
  getExternalMCPTools(getTools({ includeMCP: false }).map(tool => tool.name));
  return externalToolRoutes.get(toolName);
}

/**
 * Execute a tool call
 */
export async function executeToolCall(toolName, input) {
  switch (toolName) {
    case 'bash':
      return await executeBash(input.command);

    case 'read_file':
      return readFile(input.path);

    case 'write_file':
      return writeFile(input.path, input.content);

    case 'edit_file':
      return editFile(input.path, input.old_text, input.new_text);

    case 'read_calendar':
      return await readCalendar(input.timeframe);

    case 'write_calendar':
      return writeCalendar(input.title, input.start, input.end, input.calendar, input.location, input.notes);

    case 'write_reminder':
      return writeReminder(input.title, input.list || 'Reminders');

    case 'read_mail':
      return await readMail(input.command, input.account, input.limit, input.query, input.message_id);

    case 'read_notes':
      return await readNotes(input.action, input.note_name, input.search_term, input.folder);

    case 'write_notes':
      return writeNotes(input.action, input.title, input.body, input.folder, input.source_folder);

    case 'web_search':
      return await webSearch(input.query);

    case 'share_file':
      return await shareFile(input.filename, input.exact);

    case 'semantic_search':
      if (!isFeatureEnabled('qmd')) {
        throw new Error('QMD feature is not enabled. Run setup/qmd-setup.sh to enable semantic search.');
      }
      return await semanticSearch(input.query, input.mode, input.collection, input.limit);

    default:
      {
        const externalRoute = resolveExternalToolRoute(toolName);
        if (externalRoute) {
          const mcpManager = getMCPClientManager();
          return await mcpManager.callTool(externalRoute.serverName, externalRoute.originalName, input || {});
        }
      }
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

/**
 * Commands that could destabilize the gateway - block these
 * Cal architecture changes should happen from a local terminal or developer console
 */
const BLOCKED_PATTERNS = [
  /launchctl\s+(load|unload|stop|kill).*cal[.-]?gateway/i,
  /launchctl\s+(load|unload|stop|kill).*ai\.cal\.gateway/i,
  /kill.*gateway\.js/i,
  /pkill.*gateway/i,
];

/**
 * Execute bash command
 */
async function executeBash(command) {
  console.log(`[Tool:bash] ${command}`);

  // Block commands that could destabilize the gateway
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      console.warn(`[Tool:bash] BLOCKED dangerous command: ${command.substring(0, 50)}...`);
      return 'Error: This command is blocked. Cal architecture changes (gateway restart, launchctl) should be done from a local terminal or developer console.';
    }
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: CAL_HOME,
      timeout: 60000, // 60 second timeout
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
    });

    const output = stdout + (stderr ? `\nSTDERR: ${stderr}` : '');
    return output || '(no output)';
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

/**
 * Read file
 */
function readFile(path) {
  if (!path) {
    throw new Error('read_file requires a path parameter');
  }
  const fullPath = path.startsWith('/') ? path : join(CAL_HOME, path);
  console.log(`[Tool:read_file] ${fullPath}`);

  if (!existsSync(fullPath)) {
    throw new Error(`File not found: ${fullPath}`);
  }

  return readFileSync(fullPath, 'utf8');
}

/**
 * Write file
 */
function writeFile(path, content) {
  if (!path) {
    throw new Error('write_file requires a path parameter');
  }
  if (content === undefined || content === null) {
    throw new Error('write_file requires content parameter');
  }
  const fullPath = path.startsWith('/') ? path : join(CAL_HOME, path);
  console.log(`[Tool:write_file] ${fullPath}`);

  // Ensure directory exists
  const dir = dirname(fullPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(fullPath, content, 'utf8');
  return `File written: ${fullPath} (${content.length} bytes)`;
}

/**
 * Edit file (find & replace)
 */
function editFile(path, oldText, newText) {
  if (!path) {
    throw new Error('edit_file requires a path parameter');
  }
  if (!oldText) {
    throw new Error('edit_file requires old_text parameter');
  }
  if (newText === undefined || newText === null) {
    throw new Error('edit_file requires new_text parameter');
  }
  const fullPath = path.startsWith('/') ? path : join(CAL_HOME, path);
  console.log(`[Tool:edit_file] ${fullPath}`);

  if (!existsSync(fullPath)) {
    throw new Error(`File not found: ${fullPath}`);
  }

  const content = readFileSync(fullPath, 'utf8');

  // Count occurrences
  const occurrences = (content.match(new RegExp(escapeRegex(oldText), 'g')) || []).length;

  if (occurrences === 0) {
    throw new Error(`Text not found in file: "${oldText.substring(0, 50)}..."`);
  }

  if (occurrences > 1) {
    throw new Error(`Found ${occurrences} occurrences. Text must be unique for replacement.`);
  }

  const newContent = content.replace(oldText, newText);
  writeFileSync(fullPath, newContent, 'utf8');

  return `File edited: ${fullPath}`;
}

/**
 * Escape special regex characters
 */
function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Read Apple Calendar
 * Uses guaranteed timeout to prevent hangs when Calendar is unresponsive
 */
async function readCalendar(timeframe) {
  console.log(`[Tool:read_calendar] ${timeframe}`);

  // Check macOS and icalBuddy availability
  const macCheck = checkMacFeature('Calendar access', 'icalBuddy');
  if (macCheck) {
    throw new Error(macCheck.error);
  }

  // Get icalBuddy path dynamically
  const icalBuddy = getCommandPath('icalBuddy') || '/opt/homebrew/bin/icalBuddy';

  let command;
  switch (timeframe) {
    case 'today':
      command = `${icalBuddy} -f -ea -n eventsToday`;
      break;
    case 'tomorrow':
      command = `${icalBuddy} -f -ea -n eventsTomorrow`;
      break;
    case 'week':
      command = `${icalBuddy} -f -ea -n eventsFrom:today to:'today+7'`;
      break;
    default:
      throw new Error(`Unknown timeframe: ${timeframe}`);
  }

  try {
    const result = await execWithGuaranteedTimeout(command, { timeout: 15000 });
    return result || 'No events found.';
  } catch (err) {
    if (err.message.includes('timed out')) {
      throw new Error('Calendar is unresponsive. Try quitting and reopening Calendar.app, then retry.');
    }
    throw new Error(`Failed to read calendar: ${err.message}`);
  }
}

/**
 * Write calendar event using Shortcuts app
 * Uses Cal-CreateEvent shortcut for reliable execution from daemon context
 */
function writeCalendar(title, start, end, calendar, location = '', notes = '') {
  console.log(`[Tool:write_calendar] ${title} @ ${start}`);

  // Check macOS availability
  const macCheck = checkMacFeature('Calendar writing');
  if (macCheck) {
    throw new Error(macCheck.error);
  }

  // Build input JSON for the shortcut
  const input = JSON.stringify({
    title,
    start,
    end,
    calendar,
    location: location || undefined,
    notes: notes || undefined
  });

  try {
    // Pipe JSON to shortcut via stdin
    const result = execSync(`echo '${input.replace(/'/g, "'\\''")}' | /usr/bin/shortcuts run "Cal-CreateEvent"`, {
      encoding: 'utf8',
      timeout: 30000,
      shell: '/bin/bash'
    });
    return result || `Event "${title}" created successfully`;
  } catch (err) {
    throw new Error(`Failed to create calendar event: ${err.message}`);
  }
}

/**
 * Write reminder using Shortcuts app
 * Uses Cal-CreateReminder shortcut for reliable execution from daemon context
 */
function writeReminder(title, list = 'Reminders') {
  console.log(`[Tool:write_reminder] ${title} -> ${list}`);

  // Check macOS availability
  const macCheck = checkMacFeature('Reminders');
  if (macCheck) {
    throw new Error(macCheck.error);
  }

  // Build input JSON for the shortcut
  const input = JSON.stringify({
    title,
    list
  });

  try {
    // Pipe JSON to shortcut via stdin
    const result = execSync(`echo '${input.replace(/'/g, "'\\''")}' | /usr/bin/shortcuts run "Cal-CreateReminder"`, {
      encoding: 'utf8',
      timeout: 30000,
      shell: '/bin/bash'
    });
    return result || `Reminder "${title}" created in ${list}`;
  } catch (err) {
    throw new Error(`Failed to create reminder: ${err.message}`);
  }
}

/**
 * Read mail
 * Uses guaranteed timeout to prevent hangs when Mail.app is unresponsive
 */
async function readMail(command, account = '', limit = 10, query = '', messageId = null) {
  console.log(`[Tool:read_mail] ${command} (${account})`);

  const scriptPath = join(SCRIPTS_DIR, 'mail-reader.sh');

  if (!existsSync(scriptPath)) {
    throw new Error('mail-reader.sh not found');
  }

  let cmd;
  switch (command) {
    case 'count':
      cmd = `${scriptPath} count "${account}"`;
      break;
    case 'unread':
      cmd = `${scriptPath} unread "${account}" ${limit}`;
      break;
    case 'recent':
      cmd = `${scriptPath} recent "${account}" ${limit}`;
      break;
    case 'summary':
      cmd = `${scriptPath} summary "${account}" ${limit}`;
      break;
    case 'search':
      if (!query) {
        throw new Error('query is required for search command');
      }
      cmd = `${scriptPath} search "${query}" "${account}" ${limit}`;
      break;
    case 'read':
      if (!messageId) {
        throw new Error('message_id is required for read command');
      }
      cmd = `${scriptPath} read ${messageId}`;
      break;
    default:
      throw new Error(`Unknown mail command: ${command}`);
  }

  try {
    const result = await execWithGuaranteedTimeout(cmd, { timeout: 30000 });
    return result || 'No results.';
  } catch (err) {
    if (err.message.includes('timed out')) {
      throw new Error('Mail app is unresponsive. Try quitting and reopening Mail.app, then retry.');
    }
    throw new Error(`Failed to read mail: ${err.message}`);
  }
}

/**
 * Read Apple Notes via memo CLI
 * Uses guaranteed timeout to prevent hangs when Notes.app is unresponsive
 */
async function readNotes(action, noteName = '', searchTerm = '', folder = '') {
  console.log(`[Tool:read_notes] ${action}`);

  // Check macOS and memo availability
  const macCheck = checkMacFeature('Apple Notes', 'memo');
  if (macCheck) {
    throw new Error(macCheck.error);
  }

  const memoPath = getCommandPath('memo') || '/opt/homebrew/bin/memo';
  let cmd;

  switch (action) {
    case 'list':
      cmd = folder
        ? `${memoPath} notes --folder "${folder}" --no-cache`
        : `${memoPath} notes --no-cache`;
      break;

    case 'folders':
      cmd = `${memoPath} notes --flist --no-cache`;
      break;

    case 'read':
      if (!noteName) {
        throw new Error('note_name is required for read action');
      }
      cmd = `${memoPath} notes --search --no-cache <<< "${noteName}"`;
      break;

    case 'search':
      if (!searchTerm) {
        throw new Error('search_term is required for search action');
      }
      cmd = `${memoPath} notes --search --no-cache <<< "${searchTerm}"`;
      break;

    default:
      throw new Error(`Unknown action: ${action}. Valid actions: list, folders, read, search`);
  }

  try {
    const result = await execWithGuaranteedTimeout(cmd, { timeout: 15000 });
    return result || 'No results found.';
  } catch (err) {
    if (err.message.includes('command not found') || err.message.includes('ENOENT')) {
      throw new Error('memo CLI not installed. Install with: brew tap antoniorodr/memo && brew install antoniorodr/memo/memo');
    }
    if (err.message.includes('timed out')) {
      throw new Error('Notes app is unresponsive. Try quitting and reopening Notes.app, then retry.');
    }
    throw new Error(`Failed to read notes: ${err.message}`);
  }
}

/**
 * Convert markdown to HTML for Apple Notes
 * Handles: headings, bold, italic, lists, line breaks
 */
function markdownToHtml(text) {
  if (!text) return '';

  let html = text;

  // Escape HTML entities first (but not our generated tags)
  html = html.replace(/&/g, '&amp;');

  // Headings: ## Heading -> <h2>Heading</h2>
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold: **text** -> <strong>text</strong>
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Italic: *text* or _text_ -> <em>text</em>
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');

  // Process lists by splitting into lines
  const lines = html.split('\n');
  const result = [];
  let inUl = false;
  let inOl = false;
  let olStart = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ulMatch = line.match(/^(\s*)[-*] (.+)$/);
    const olMatch = line.match(/^(\s*)(\d+)\. (.+)$/);

    if (ulMatch) {
      if (!inUl) {
        if (inOl) { result.push('</ol>'); inOl = false; }
        result.push('<ul>');
        inUl = true;
      }
      result.push(`<li>${ulMatch[2]}</li>`);
    } else if (olMatch) {
      if (!inOl) {
        if (inUl) { result.push('</ul>'); inUl = false; }
        olStart = parseInt(olMatch[2]);
        result.push(olStart === 1 ? '<ol>' : `<ol start="${olStart}">`);
        inOl = true;
      }
      result.push(`<li>${olMatch[3]}</li>`);
    } else {
      if (inUl) { result.push('</ul>'); inUl = false; }
      if (inOl) { result.push('</ol>'); inOl = false; }

      // Convert blank lines to paragraph breaks, other lines stay as-is
      if (line.trim() === '') {
        result.push('<br><br>');
      } else if (!line.startsWith('<h')) {
        result.push(line);
      } else {
        result.push(line);
      }
    }
  }

  // Close any open lists
  if (inUl) result.push('</ul>');
  if (inOl) result.push('</ol>');

  // Join with <br> instead of \n — Apple Notes uses HTML line breaks,
  // and newlines break AppleScript string parsing in osascript -e mode
  return result.join('<br>');
}

/**
 * Write Apple Notes via AppleScript
 * Supports create, move, and delete operations
 * Automatically converts markdown to HTML for rich text rendering
 */
function writeNotes(action, title, body = '', folder = 'Notes', sourceFolder = '') {
  console.log(`[Tool:write_notes] ${action}: ${title}`);

  // Check macOS availability (AppleScript requires macOS)
  const macCheck = checkMacFeature('Apple Notes writing');
  if (macCheck) {
    throw new Error(macCheck.error);
  }

  // Escape for AppleScript strings (double-quote delimited)
  // Backslash-escape double quotes and backslashes
  const escapeAS = (str) => str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  // Convert markdown to HTML for create action
  const htmlBody = action === 'create' ? markdownToHtml(body) : body;

  let script;
  switch (action) {
    case 'create':
      script = `tell application "Notes" to make new note at folder "${escapeAS(folder)}" with properties {name:"${escapeAS(title)}", body:"${escapeAS(htmlBody)}"}`;
      break;

    case 'move':
      if (!folder) {
        throw new Error('folder is required for move action');
      }
      if (sourceFolder) {
        script = `tell application "Notes"
          set theNote to note "${escapeAS(title)}" of folder "${escapeAS(sourceFolder)}"
          move theNote to folder "${escapeAS(folder)}"
        end tell`;
      } else {
        // Search all folders for the note
        script = `tell application "Notes"
          set theNote to first note whose name is "${escapeAS(title)}"
          move theNote to folder "${escapeAS(folder)}"
        end tell`;
      }
      break;

    case 'delete':
      if (sourceFolder) {
        script = `tell application "Notes" to delete note "${escapeAS(title)}" of folder "${escapeAS(sourceFolder)}"`;
      } else {
        script = `tell application "Notes" to delete (first note whose name is "${escapeAS(title)}")`;
      }
      break;

    default:
      throw new Error(`Unknown action: ${action}. Valid actions: create, move, delete`);
  }

  try {
    // Write script to temp file to avoid shell escaping issues with
    // multi-line HTML content, special characters, quotes, etc.
    const tmpFile = join(CAL_HOME, 'cal-gateway', 'data', 'tmp-notes-script.applescript');
    const tmpDir = dirname(tmpFile);
    if (!existsSync(tmpDir)) {
      mkdirSync(tmpDir, { recursive: true });
    }
    writeFileSync(tmpFile, script, 'utf8');

    execSync(`osascript "${tmpFile}"`, {
      encoding: 'utf8',
      timeout: 30000,
    });

    // Clean up temp file
    try { execSync(`rm "${tmpFile}"`, { timeout: 5000 }); } catch (e) { /* ignore */ }

    switch (action) {
      case 'create':
        return `Note "${title}" created in folder "${folder}"`;
      case 'move':
        return `Note "${title}" moved to folder "${folder}"`;
      case 'delete':
        return `Note "${title}" deleted`;
    }
  } catch (err) {
    throw new Error(`Failed to ${action} note: ${err.message}`);
  }
}

/**
 * Web search using Brave API
 */
async function webSearch(query) {
  console.log(`[Tool:web_search] ${query}`);

  try {
    const { stdout } = await execAsync(
      `${SCRIPTS_DIR}/brave-search.sh "${query.replace(/"/g, '\\"')}"`,
      { timeout: 15000 }
    );
    return stdout || 'No results found';
  } catch (err) {
    return `Error searching: ${err.message}`;
  }
}

/**
 * Semantic search using QMD
 * Searches Cal's indexed knowledge base using hybrid search (BM25 + vectors + LLM reranking)
 *
 * Uses MCP client to communicate with QMD daemon (fast, indexes stay in RAM).
 * Requires QMD daemon to be running - no CLI fallback.
 */
async function semanticSearch(query, mode = 'hybrid', collection = 'all', limit = 5) {
  console.log(`[Tool:semantic_search] ${query} (mode: ${mode}, collection: ${collection})`);

  const mcpManager = getMCPClientManager();

  if (!mcpManager.isConnected('qmd')) {
    return `Error: QMD MCP server not connected.

Troubleshooting:
1. Check if daemon is running: launchctl list | grep qmd
2. Start daemon: launchctl start ai.qmd.daemon
3. Check logs: tail -f ~/harness/cal-gateway/logs/qmd-daemon-error.log`;
  }

  try {
    // Build searches array based on mode
    // QMD MCP requires typed sub-queries: lex (keyword), vec (semantic), hyde (hypothetical)
    let searches;
    switch (mode) {
      case 'keyword':
        searches = [{ type: 'lex', query }];
        break;
      case 'semantic':
        searches = [{ type: 'vec', query }];
        break;
      case 'hybrid':
      default:
        // Hybrid: combine lexical and semantic for best recall
        searches = [
          { type: 'lex', query },
          { type: 'vec', query },
        ];
        break;
    }

    // Build MCP tool arguments
    const args = {
      searches,
      limit,
      intent: query, // Use query as intent for disambiguation
    };

    // Add collection filter if specified
    if (collection && collection !== 'all') {
      args.collections = [collection];
    }

    const result = await mcpManager.callTool('qmd', 'query', args);

    if (!result || (typeof result === 'string' && result.trim() === '')) {
      return 'No results found for your query.';
    }

    return result;
  } catch (err) {
    console.error('[Tool:semantic_search] MCP call failed:', err.message);
    return `Error searching: ${err.message}`;
  }
}

/**
 * Share file via OneDrive/SharePoint URL
 * Looks up the SharePoint URL from OneDrive's local sync database
 */
async function shareFile(filename, exact = false) {
  console.log(`[Tool:share_file] ${filename} (exact: ${exact})`);

  const dbPath = `${process.env.HOME}/Library/Application Support/OneDrive/settings/Business1/SyncEngineDatabase.db`;

  if (!existsSync(dbPath)) {
    return 'Error: OneDrive sync database not found. Is OneDrive installed and syncing?';
  }

  try {
    // Search for matching files
    const searchPattern = exact ? filename : `%${filename}%`;
    const searchQuery = `
      SELECT resourceID, parentResourceID, fileName
      FROM od_ClientFile_Records
      WHERE fileName LIKE '${searchPattern.replace(/'/g, "''")}'
      LIMIT 10;
    `;

    const filesResult = await execAsync(`sqlite3 "${dbPath}" "${searchQuery}"`, { timeout: 10000 });

    if (!filesResult.stdout.trim()) {
      return `No files found matching "${filename}". Try a different search term.`;
    }

    const files = filesResult.stdout.trim().split('\n').map(line => {
      const [resourceID, parentResourceID, fileName] = line.split('|');
      return { resourceID, parentResourceID, fileName };
    });

    // If multiple matches, list them
    if (files.length > 1) {
      const fileList = files.map((f, i) => `${i + 1}. ${f.fileName}`).join('\n');
      return `Found ${files.length} matching files:\n${fileList}\n\nPlease be more specific, or use exact:true with the full filename.`;
    }

    const file = files[0];

    // Walk up the folder tree to build the path
    // Key insight: shortcuts create cross-scope references. We need to:
    // 1. Get the scope from the FIRST folder (closest to file) - that's where it actually lives
    // 2. Only include folders that belong to that same scope in the path
    const pathQuery = `
      WITH RECURSIVE folder_path AS (
        SELECT resourceID, parentResourceID, parentScopeID, folderName, 1 as level
        FROM od_ClientFolder_Records
        WHERE resourceID = '${file.parentResourceID}'

        UNION ALL

        SELECT f.resourceID, f.parentResourceID, f.parentScopeID, f.folderName, fp.level + 1
        FROM od_ClientFolder_Records f
        JOIN folder_path fp ON f.resourceID = fp.parentResourceID
        WHERE fp.parentResourceID != ''
      ),
      first_scope AS (
        SELECT parentScopeID FROM folder_path WHERE level = 1
      )
      SELECT
        (SELECT group_concat(folderName, '/') FROM (
          SELECT folderName FROM folder_path
          WHERE parentScopeID = (SELECT parentScopeID FROM first_scope)
          ORDER BY level DESC
        )) as path,
        (SELECT parentScopeID FROM first_scope) as scopeID;
    `;

    const pathResult = await execAsync(`sqlite3 "${dbPath}" "${pathQuery}"`, { timeout: 10000 });
    const [folderPath, scopeID] = pathResult.stdout.trim().split('|');

    // Get the base URL from scope
    const scopeQuery = `SELECT webURL, remotePath, libraryType FROM od_ScopeInfo_Records WHERE scopeID = '${scopeID}';`;
    const scopeResult = await execAsync(`sqlite3 "${dbPath}" "${scopeQuery}"`, { timeout: 10000 });

    if (!scopeResult.stdout.trim()) {
      return `Error: Could not find OneDrive scope information for this file.`;
    }

    const [webURL, remotePath, libraryType] = scopeResult.stdout.trim().split('|');

    // Build the full URL
    // libraryType 2 = personal OneDrive, 4 = SharePoint team site
    const docFolder = libraryType === '2' ? 'Documents' : 'Shared Documents';

    // URL encode the path components
    const encodedPath = folderPath ? folderPath.split('/').map(p => encodeURIComponent(p)).join('/') : '';
    const encodedFile = encodeURIComponent(file.fileName);

    let fullURL;
    if (remotePath) {
      fullURL = `${webURL}/${docFolder}/${remotePath}/${encodedPath}/${encodedFile}`;
    } else {
      fullURL = `${webURL}/${docFolder}/${encodedPath}/${encodedFile}`;
    }

    // Clean up any double slashes (except in https://)
    fullURL = fullURL.replace(/([^:])\/\//g, '$1/');

    // Determine file type for app URL scheme
    const ext = file.fileName.split('.').pop().toLowerCase();
    const appSchemes = {
      'doc': 'ms-word', 'docx': 'ms-word', 'docm': 'ms-word',
      'xls': 'ms-excel', 'xlsx': 'ms-excel', 'xlsm': 'ms-excel',
      'ppt': 'ms-powerpoint', 'pptx': 'ms-powerpoint', 'pptm': 'ms-powerpoint',
    };

    const appScheme = appSchemes[ext];
    let result = `📎 **${file.fileName}**\n\n`;

    if (appScheme) {
      // For Office files, provide the app-open URL (works better on mobile)
      const appURL = `${appScheme}:ofe|u|${fullURL}`;
      result += `**Open in app:** ${appURL}\n\n**Web:** ${fullURL}`;
    } else {
      result += fullURL;
    }

    return result;

  } catch (err) {
    console.error('[Tool:share_file] Error:', err.message);
    return `Error looking up file: ${err.message}`;
  }
}
