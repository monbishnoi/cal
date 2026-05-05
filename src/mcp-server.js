/**
 * MCP Server for Cal Gateway
 *
 * Exposes Cal Gateway capabilities to any MCP client.
 *
 * Architecture:
 * - Dynamically exposes ALL tools Cal has access to
 * - Internal tools from tools.js (calendar, mail, notes, file ops, etc.)
 * - External MCP tools from connected servers
 * - Session/memory tools for cross-channel continuity
 *
 * Public distribution exposes whatever MCP servers the user configures.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { MEMORY_DIR, CONTEXT_DIR } from './paths.js';
import { getSession as getSessionFromStore, getAllSessionIds } from './session-store.js';
import { getTools as getInternalTools, executeToolCall } from './tools.js';
import { getMCPClientManager, initMCPClients } from './mcp-client.js';
import { loadGatewayConfig, filterRuntimeMCPServers } from './runtime-config.js';

// HTTP port for Gateway relay (must match http-server.js)
const GATEWAY_HTTP_PORT = process.env.CAL_HTTP_PORT || 8080;

/**
 * Load MCP server configuration from jobs.json
 */
function loadMCPConfig() {
  const config = loadGatewayConfig();
  return filterRuntimeMCPServers(config.mcpServers || {});
}

/**
 * Initialize connections to external MCP servers.
 * This makes their tools available through this MCP server
 */
async function initExternalMCPServers() {
  const mcpConfig = loadMCPConfig();

  if (Object.keys(mcpConfig).length === 0) {
    console.error('[MCP Server] No MCP servers configured');
    return;
  }

  // Build auth providers for servers that need OAuth.
  // Public distribution does not ship provider-specific OAuth handlers by default.
  const authProviders = {};

  // Initialize all configured MCP servers
  await initMCPClients(mcpConfig, authProviders);

  // Log status
  const manager = getMCPClientManager();
  const status = manager.getStatus();

  console.error(`[MCP Server] Connected to ${status.length} external MCP server(s)`);
  for (const server of status) {
    console.error(`[MCP Server]   - ${server.name}: ${server.tools} tools`);
  }
}

/**
 * Session/Memory tools - Cal-specific tools for cross-channel continuity
 * These are always available regardless of configuration
 */
const SESSION_TOOLS = [
  {
    name: 'get_session_context',
    description: 'Get Cal\'s current session context including recent cross-channel activity, last interaction details, and conversation summary. Use this at the start of a conversation to understand what Cal has been doing on other channels.',
    inputSchema: {
      type: 'object',
      properties: {
        includeHistory: {
          type: 'boolean',
          description: 'Include recent message history (default: false)',
        },
        limit: {
          type: 'number',
          description: 'Number of recent messages to include (default: 5)',
        },
      },
    },
  },
  {
    name: 'get_memory',
    description: 'Query Cal\'s persistent memory (MEMORY.md). Returns relevant memory entries about the user, their preferences, ongoing projects, and feedback.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional search query to filter memory entries',
        },
        section: {
          type: 'string',
          enum: ['all', 'user', 'project', 'feedback', 'reference'],
          description: 'Specific memory section to retrieve (default: all)',
        },
      },
    },
  },
  {
    name: 'get_daily_log',
    description: 'Read Cal\'s daily log for a specific date. Contains interactions, decisions, and context from that day.',
    inputSchema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Date in YYYY-MM-DD format (default: today)',
        },
      },
    },
  },
  {
    name: 'send_to_channel',
    description: 'Send a message to one of Cal\'s configured channels. Use when the user asks to relay information to another channel.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          enum: ['telegram', 'imessage'],
          description: 'Target channel',
        },
        message: {
          type: 'string',
          description: 'Message to send',
        },
      },
      required: ['channel', 'message'],
    },
  },
];

/**
 * Convert tools.js format (input_schema) to MCP format (inputSchema)
 */
function convertToMCPFormat(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.input_schema || tool.inputSchema,
  };
}

/**
 * Get ALL available tools dynamically
 * Combines: session tools + internal tools + external MCP tools
 */
function getAllTools() {
  const allTools = [];

  // 1. Session/Memory tools (always available)
  allTools.push(...SESSION_TOOLS);

  // 2. Internal tools from tools.js (calendar, mail, notes, etc.)
  const internalTools = getInternalTools({ includeMCP: false });
  for (const tool of internalTools) {
    allTools.push(convertToMCPFormat(tool));
  }

  // 3. External MCP tools from connected servers
  const mcpManager = getMCPClientManager();
  const externalTools = mcpManager.getAllTools();
  for (const { serverName, tool } of externalTools) {
    // Build tool name - avoid double-prefixing if tool already has server prefix.
    const toolNameLower = tool.name.toLowerCase();
    const serverPrefix = serverName.toLowerCase().replace(/-/g, '_') + '_';
    const alreadyPrefixed = toolNameLower.startsWith(serverPrefix) ||
                           toolNameLower.startsWith(serverName.toLowerCase().replace(/-/g, '') + '_');

    const exposedName = alreadyPrefixed ? tool.name : `${serverName}_${tool.name}`;

    allTools.push({
      name: exposedName,
      description: `[${serverName}] ${tool.description}`,
      inputSchema: tool.inputSchema,
      _serverName: serverName,  // Internal: track which server handles this
      _originalName: tool.name, // Internal: original tool name for calling
    });
  }

  return allTools;
}

/**
 * Get session context for the active assistant runtime
 */
function getSessionContext(includeHistory = false, limit = 5) {
  const sessionIds = getAllSessionIds();
  const now = Date.now();

  const sessions = sessionIds.map(id => {
    const session = getSessionFromStore(id);
    if (!session) return null;

    const lastActivity = session.lastActivity || 0;
    const ageMs = now - lastActivity;
    const ageMinutes = Math.round(ageMs / 60000);

    let channel = 'unknown';
    if (id.includes('telegram')) channel = 'telegram';
    else if (id.includes('imessage')) channel = 'imessage';
    else if (id.includes('a2a') || id.includes('http')) channel = 'http';
    else channel = 'main';

    const context = {
      sessionId: id,
      channel,
      lastActivity: new Date(lastActivity).toISOString(),
      ageMinutes,
      messageCount: session.messages?.length || 0,
    };

    if (includeHistory && session.messages?.length > 0) {
      const recentMessages = session.messages.slice(-limit * 2);
      context.recentMessages = recentMessages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string'
          ? m.content.substring(0, 200) + (m.content.length > 200 ? '...' : '')
          : '[complex content]',
      }));
    }

    return context;
  }).filter(Boolean);

  sessions.sort((a, b) => a.ageMinutes - b.ageMinutes);

  const mostRecent = sessions[0];
  let summary = '';

  if (mostRecent) {
    if (mostRecent.ageMinutes < 5) {
      summary = `Active session on ${mostRecent.channel} (${mostRecent.messageCount} messages). `;
    } else if (mostRecent.ageMinutes < 60) {
      summary = `Last interaction ${mostRecent.ageMinutes} minutes ago on ${mostRecent.channel}. `;
    } else {
      const hours = Math.round(mostRecent.ageMinutes / 60);
      summary = `Last interaction ${hours} hour(s) ago on ${mostRecent.channel}. `;
    }
  } else {
    summary = 'No recent session activity. ';
  }

  const today = new Date().toISOString().split('T')[0];
  const dailyLogPath = join(MEMORY_DIR, `${today}.md`);
  let dailyLogSummary = '';

  if (existsSync(dailyLogPath)) {
    try {
      const logContent = readFileSync(dailyLogPath, 'utf8');
      dailyLogSummary = `Today's log exists (${logContent.length} chars). `;
    } catch {
      // Ignore read errors
    }
  }

  return {
    summary: summary + dailyLogSummary,
    activeSessions: sessions.length,
    sessions: sessions.slice(0, 5),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Get memory content
 */
function getMemory(query, section = 'all') {
  const memoryPath = join(CONTEXT_DIR, 'MEMORY.md');

  if (!existsSync(memoryPath)) {
    return { error: 'MEMORY.md not found', path: memoryPath };
  }

  try {
    const content = readFileSync(memoryPath, 'utf8');

    if (!query && section === 'all') {
      return {
        content: content.substring(0, 10000) + (content.length > 10000 ? '\n\n[truncated...]' : ''),
        length: content.length,
      };
    }

    if (section !== 'all') {
      const sectionMap = {
        user: /## .*User|## .*Person|## .*Profile/i,
        project: /## .*Project|## .*Work|## .*Current/i,
        feedback: /## .*Feedback|## .*Preference/i,
        reference: /## .*Reference|## .*Link/i,
      };

      const pattern = sectionMap[section];
      if (pattern) {
        const lines = content.split('\n');
        let capturing = false;
        let captured = [];

        for (const line of lines) {
          if (line.startsWith('## ')) {
            capturing = pattern.test(line);
          }
          if (capturing) {
            captured.push(line);
          }
        }

        return {
          section,
          content: captured.join('\n') || `No content found for section: ${section}`,
        };
      }
    }

    if (query) {
      const queryLower = query.toLowerCase();
      const lines = content.split('\n');
      const matches = lines.filter(line => line.toLowerCase().includes(queryLower));

      return {
        query,
        matches: matches.slice(0, 20),
        matchCount: matches.length,
      };
    }

    return { content };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Get daily log
 */
function getDailyLog(date) {
  const targetDate = date || new Date().toISOString().split('T')[0];
  const logPath = join(MEMORY_DIR, `${targetDate}.md`);

  if (!existsSync(logPath)) {
    return { error: `No daily log found for ${targetDate}`, date: targetDate };
  }

  try {
    const content = readFileSync(logPath, 'utf8');
    return {
      date: targetDate,
      content: content.substring(0, 15000) + (content.length > 15000 ? '\n\n[truncated...]' : ''),
      length: content.length,
    };
  } catch (err) {
    return { error: err.message, date: targetDate };
  }
}

/**
 * Send message to a channel via Gateway HTTP relay
 */
async function sendToChannel(channel, message) {
  if (channel !== 'telegram' && channel !== 'imessage') {
    return { error: `Unknown channel: ${channel}` };
  }

  try {
    const response = await fetch(`http://127.0.0.1:${GATEWAY_HTTP_PORT}/api/send-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, message }),
    });

    const result = await response.json();

    if (!response.ok) {
      return { error: result.error || `HTTP ${response.status}`, channel };
    }

    return result;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      return { error: 'Gateway not running. Start cal-gateway first.', channel };
    }
    return { error: err.message, channel };
  }
}

/**
 * Handle tool execution
 * Routes to appropriate handler: session tools, internal tools, or external MCP tools
 */
async function handleToolCall(name, args, toolMeta = {}) {
  // 1. Session/Memory tools (handled here)
  switch (name) {
    case 'get_session_context':
      return getSessionContext(args.includeHistory, args.limit);

    case 'get_memory':
      return getMemory(args.query, args.section);

    case 'get_daily_log':
      return getDailyLog(args.date);

    case 'send_to_channel':
      return await sendToChannel(args.channel, args.message);
  }

  // 2. Check if this is an external MCP tool (prefixed with server name)
  if (toolMeta._serverName && toolMeta._originalName) {
    const mcpManager = getMCPClientManager();
    return await mcpManager.callTool(toolMeta._serverName, toolMeta._originalName, args);
  }

  // 3. Check if tool name contains underscore and might be external
  // This handles calls where we don't have toolMeta (e.g., direct name lookup)
  const underscoreIndex = name.indexOf('_');
  if (underscoreIndex > 0) {
    const possibleServer = name.substring(0, underscoreIndex);
    const possibleTool = name.substring(underscoreIndex + 1);
    const mcpManager = getMCPClientManager();

    if (mcpManager.isConnected(possibleServer)) {
      const serverTools = mcpManager.getTools(possibleServer);
      if (serverTools.some(t => t.name === possibleTool)) {
        return await mcpManager.callTool(possibleServer, possibleTool, args);
      }
    }
  }

  // 4. Internal tools from tools.js (calendar, mail, notes, etc.)
  try {
    return await executeToolCall(name, args);
  } catch (err) {
    throw new Error(`Tool '${name}' not found or failed: ${err.message}`);
  }
}

/**
 * Create and start the MCP server
 */
export async function startMCPServer() {
  console.error('[MCP Server] Starting Cal Gateway MCP server...');

  // Initialize connections to configured external MCP servers.
  // This makes their tools available through this MCP server
  await initExternalMCPServers();

  const server = new Server(
    {
      name: 'cal-gateway',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Cache for tool metadata (for routing external tool calls)
  let toolCache = new Map();

  // Handle list tools request - returns ALL available tools dynamically
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const allTools = getAllTools();

    // Update tool cache for routing
    toolCache.clear();
    for (const tool of allTools) {
      if (tool._serverName) {
        toolCache.set(tool.name, {
          _serverName: tool._serverName,
          _originalName: tool._originalName,
        });
      }
    }

    // Return tools without internal metadata
    const publicTools = allTools.map(({ _serverName, _originalName, ...tool }) => tool);

    console.error(`[MCP Server] Listing ${publicTools.length} tools`);
    return { tools: publicTools };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      // Get tool metadata if it's an external tool
      const toolMeta = toolCache.get(name) || {};

      const result = await handleToolCall(name, args || {}, toolMeta);

      return {
        content: [
          {
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${err.message}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Start with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log available tools on startup
  const tools = getAllTools();
  const internalCount = getInternalTools({ includeMCP: false }).length + SESSION_TOOLS.length;
  const externalCount = tools.length - internalCount;

  console.error(`[MCP Server] Cal Gateway MCP server started`);
  console.error(`[MCP Server] Tools: ${tools.length} total (${internalCount} internal, ${externalCount} external)`);

  return server;
}

// If run directly (not imported), start the server
if (process.argv[1]?.endsWith('mcp-server.js')) {
  startMCPServer().catch(err => {
    console.error('[MCP Server] Failed to start:', err.message);
    process.exit(1);
  });
}
