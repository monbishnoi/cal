/**
 * MCP Client Manager for Cal Gateway
 *
 * Provides a generic MCP client infrastructure that can connect to any MCP server.
 * Supports both HTTP transport (for remote servers) and stdio transport (for local process-based servers).
 *
 * Usage:
 *   const manager = new MCPClientManager();
 *   // HTTP server
 *   await manager.connect('qmd', { endpoint: process.env.QMD_ENDPOINT });
 *   // Stdio server
 *   await manager.connect('local-tools', { type: 'stdio', command: 'node', args: ['server.js'] });
 *   const result = await manager.callTool('qmd', 'query', { query: 'test' });
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { CAL_HOME, GATEWAY_DIR } from './paths.js';
import { expandUserPlaceholders } from './user-config.js';
import { filterRuntimeMCPServers } from './runtime-config.js';

function expandConfigString(value) {
  if (typeof value !== 'string') {
    return value;
  }

  return expandUserPlaceholders(value)
    .replace(/\{\{CAL_HOME\}\}/g, CAL_HOME)
    .replace(/\{\{GATEWAY_DIR\}\}/g, GATEWAY_DIR)
    .replace(/\{\{HOME\}\}/g, process.env.HOME || '');
}

function expandConnectionConfig(config) {
  const expanded = { ...config };

  if (expanded.endpoint) expanded.endpoint = expandConfigString(expanded.endpoint);
  if (expanded.command) expanded.command = expandConfigString(expanded.command);
  if (expanded.cwd) expanded.cwd = expandConfigString(expanded.cwd);
  if (Array.isArray(expanded.args)) {
    expanded.args = expanded.args.map(arg => expandConfigString(arg));
  }
  if (expanded.env && typeof expanded.env === 'object') {
    expanded.env = Object.fromEntries(
      Object.entries(expanded.env).map(([key, value]) => [key, expandConfigString(value)])
    );
  }

  return expanded;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileToolPattern(pattern) {
  if (pattern instanceof RegExp) {
    return pattern;
  }

  try {
    return new RegExp(String(pattern), 'i');
  } catch {
    return new RegExp(escapeRegex(pattern), 'i');
  }
}

function createToolPolicy(config = {}) {
  return {
    allowedTools: Array.isArray(config.allowedTools) && config.allowedTools.length > 0
      ? new Set(config.allowedTools)
      : null,
    blockedTools: new Set(Array.isArray(config.blockedTools) ? config.blockedTools : []),
    blockedToolPatterns: Array.isArray(config.blockedToolPatterns)
      ? config.blockedToolPatterns.map(compileToolPattern)
      : [],
  };
}

/**
 * Manages multiple MCP client connections
 */
export class MCPClientManager {
  constructor() {
    this.clients = new Map();      // serverName -> Client instance
    this.transports = new Map();   // serverName -> Transport instance
    this.tools = new Map();        // serverName -> available tools
    this.processes = new Map();    // serverName -> child process (for stdio servers)
    this.policies = new Map();     // serverName -> allow/block policy
  }

  setPolicy(name, config = {}) {
    this.policies.set(name, createToolPolicy(config));
  }

  isToolAllowed(serverName, toolName) {
    const policy = this.policies.get(serverName);
    if (!policy) return true;

    if (policy.allowedTools && !policy.allowedTools.has(toolName)) {
      return false;
    }

    if (policy.blockedTools.has(toolName)) {
      return false;
    }

    return !policy.blockedToolPatterns.some(pattern => pattern.test(toolName));
  }

  filterTools(serverName, tools = []) {
    const filtered = tools.filter(tool => this.isToolAllowed(serverName, tool.name));
    const blocked = tools.filter(tool => !this.isToolAllowed(serverName, tool.name));

    if (blocked.length > 0) {
      console.warn(`[MCP] ${serverName}: policy blocked tools: ${blocked.map(t => t.name).join(', ')}`);
    }

    return filtered;
  }

  /**
   * Connect to an MCP server (HTTP or stdio)
   *
   * @param {string} name - Unique name for this server (e.g., 'qmd', 'local-tools')
   * @param {Object} config - Server configuration
   * @param {string} [config.endpoint] - HTTP endpoint URL (for HTTP transport)
   * @param {string} [config.type] - Transport type: 'http' or 'stdio' (default: 'http' if endpoint provided)
   * @param {string} [config.command] - Command to run (for stdio transport)
   * @param {Array} [config.args] - Command arguments (for stdio transport)
   * @param {Object} [config.env] - Environment variables (for stdio transport)
   * @param {Object} [config.authProvider] - OAuth provider for authenticated servers
   * @returns {Promise<Array>} - List of available tools from the server
   */
  async connect(name, config = {}, options = {}) {
    if (typeof config === 'string') {
      config = { ...options, endpoint: config };
    }

    this.setPolicy(name, config);

    // Determine transport type
    const transportType = config.type || (config.endpoint ? 'http' : 'stdio');

    if (transportType === 'stdio') {
      return this.connectStdio(name, config);
    } else {
      return this.connectHttp(name, config.endpoint || config, config);
    }
  }

  /**
   * Connect to an HTTP-based MCP server
   */
  async connectHttp(name, endpoint, options = {}) {
    // Handle legacy call signature: connect(name, endpointString, options)
    if (typeof endpoint === 'string') {
      console.log(`[MCP] Connecting to ${name} at ${endpoint} (HTTP)...`);
    } else {
      // New signature: connect(name, config)
      options = endpoint;
      endpoint = options.endpoint;
      console.log(`[MCP] Connecting to ${name} at ${endpoint} (HTTP)...`);
    }

    let transport = null;
    let client = null;

    try {
      const transportOpts = {};
      if (options.authProvider) {
        transportOpts.authProvider = options.authProvider;
        console.log(`[MCP] Using OAuth authentication for ${name}`);
      }

      transport = new StreamableHTTPClientTransport(
        new URL(endpoint),
        transportOpts
      );

      client = new Client(
        { name: 'cal-gateway', version: '0.2.0' },
        { capabilities: { tools: {} } }
      );

      await client.connect(transport);

      const toolsResponse = await client.listTools();
      const discoveredTools = toolsResponse.tools || [];
      const tools = this.filterTools(name, discoveredTools);

      this.clients.set(name, client);
      this.transports.set(name, transport);
      this.tools.set(name, tools);

      console.log(`[MCP] Connected to ${name}: ${tools.length}/${discoveredTools.length} tools available after policy`);
      console.log(`[MCP] Tools: ${tools.map(t => t.name).join(', ')}`);

      return tools;
    } catch (err) {
      if (err instanceof UnauthorizedError && transport && client) {
        console.log(`[MCP] ${name} requires OAuth authentication`);
        console.log(`[MCP] Run the appropriate auth command to complete authorization`);

        this.transports.set(name, transport);
        this.clients.set(name, client);
        this.pendingAuth = this.pendingAuth || new Map();
        this.pendingAuth.set(name, { transport, client, endpoint, options });

        return [];
      }
      console.error(`[MCP] Failed to connect to ${name}:`, err.message);
      throw err;
    }
  }

  /**
   * Connect to a stdio-based MCP server (spawns a child process)
   */
  async connectStdio(name, config) {
    const { command, args = [], env = {}, cwd = GATEWAY_DIR } = config;

    if (!command) {
      throw new Error(`[MCP] Stdio server '${name}' requires a 'command' field`);
    }

    console.log(`[MCP] Connecting to ${name} via stdio (${command} ${args.join(' ')}) from ${cwd}...`);

    try {
      // Merge environment variables
      const processEnv = { ...process.env, ...env };

      // Expand ~ in env vars
      for (const [key, value] of Object.entries(processEnv)) {
        if (typeof value === 'string' && value.startsWith('~')) {
          processEnv[key] = value.replace('~', process.env.HOME);
        }
      }

      // Create stdio transport
      const transport = new StdioClientTransport({
        command,
        args,
        env: processEnv,
        cwd,
      });

      // Create MCP client
      const client = new Client(
        { name: 'cal-gateway', version: '0.2.0' },
        { capabilities: { tools: {} } }
      );

      // Connect (this spawns the process and does MCP handshake)
      await client.connect(transport);

      // Discover available tools
      const toolsResponse = await client.listTools();
      const discoveredTools = toolsResponse.tools || [];
      const tools = this.filterTools(name, discoveredTools);

      // Store references
      this.clients.set(name, client);
      this.transports.set(name, transport);
      this.tools.set(name, tools);

      console.log(`[MCP] Connected to ${name}: ${tools.length}/${discoveredTools.length} tools available after policy`);
      if (tools.length > 0) {
        console.log(`[MCP] Tools: ${tools.map(t => t.name).join(', ')}`);
      }

      return tools;
    } catch (err) {
      console.error(`[MCP] Failed to connect to ${name}:`, err.message);
      throw err;
    }
  }

  /**
   * Check if connected to a server
   *
   * @param {string} name - Server name
   * @returns {boolean}
   */
  isConnected(name) {
    return this.clients.has(name);
  }

  /**
   * Get available tools from a server
   *
   * @param {string} name - Server name
   * @returns {Array} - List of tool definitions
   */
  getTools(name) {
    return this.tools.get(name) || [];
  }

  /**
   * Get all tools from all connected servers
   *
   * @returns {Array} - List of { serverName, tool } objects
   */
  getAllTools() {
    const allTools = [];
    for (const [serverName, tools] of this.tools) {
      for (const tool of tools) {
        allTools.push({ serverName, tool });
      }
    }
    return allTools;
  }

  /**
   * Call a tool on an MCP server
   *
   * @param {string} serverName - Name of the server
   * @param {string} toolName - Name of the tool to call
   * @param {Object} args - Arguments to pass to the tool
   * @returns {Promise<any>} - Tool result
   */
  async callTool(serverName, toolName, args = {}) {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP server '${serverName}' not connected`);
    }

    if (!this.isToolAllowed(serverName, toolName)) {
      throw new Error(`MCP tool '${serverName}/${toolName}' is blocked by Gateway policy`);
    }

    console.log(`[MCP] Calling ${serverName}/${toolName}`, args);

    try {
      const result = await client.callTool({
        name: toolName,
        arguments: args,
      });

      // Extract text content from MCP response format
      if (result.content && Array.isArray(result.content)) {
        const textContent = result.content.find(c => c.type === 'text');
        if (textContent) {
          return textContent.text;
        }
      }

      // Return raw result if not in expected format
      return result;
    } catch (err) {
      console.error(`[MCP] Tool call failed: ${serverName}/${toolName}`, err.message);
      throw err;
    }
  }

  /**
   * Disconnect from a specific server
   *
   * @param {string} name - Server name
   */
  async disconnect(name) {
    const client = this.clients.get(name);
    if (client) {
      console.log(`[MCP] Disconnecting from ${name}...`);
      try {
        await client.close();
      } catch (err) {
        console.warn(`[MCP] Error closing ${name}:`, err.message);
      }
      this.clients.delete(name);
      this.transports.delete(name);
      this.tools.delete(name);
      this.policies.delete(name);
    }
  }

  /**
   * Disconnect from all servers
   */
  async disconnectAll() {
    console.log('[MCP] Disconnecting from all servers...');
    const names = Array.from(this.clients.keys());
    for (const name of names) {
      await this.disconnect(name);
    }
  }

  /**
   * Complete OAuth authentication for a pending server.
   * Called after the user completes browser auth and the callback delivers the code.
   *
   * @param {string} name - Server name
   * @param {string} authorizationCode - The OAuth authorization code from the callback
   * @returns {Promise<Array>} - List of available tools after successful auth
   */
  async completeAuth(name, authorizationCode) {
    const pending = this.pendingAuth?.get(name);
    if (!pending) {
      throw new Error(`No pending auth for server '${name}'`);
    }

    const { transport, client, endpoint, options } = pending;

    console.log(`[MCP] Completing OAuth for ${name}...`);

    try {
      // Exchange auth code for tokens via the transport
      await transport.finishAuth(authorizationCode);
      console.log(`[MCP] OAuth tokens obtained for ${name}`);

      // Now reconnect with the authenticated transport
      this.pendingAuth.delete(name);
      this.clients.delete(name);
      this.transports.delete(name);

      // Reconnect — this time tokens are saved, so auth should succeed
      return await this.connect(name, endpoint, options);
    } catch (err) {
      console.error(`[MCP] OAuth completion failed for ${name}:`, err.message);
      throw err;
    }
  }

  /**
   * Check if a server has pending OAuth authentication
   *
   * @param {string} name - Server name
   * @returns {boolean}
   */
  hasPendingAuth(name) {
    return this.pendingAuth?.has(name) || false;
  }

  /**
   * Reconnect to a server (useful after connection loss)
   *
   * @param {string} name - Server name
   * @param {string} endpoint - Server endpoint
   * @param {Object} [options] - Connection options
   */
  async reconnect(name, endpoint, options = {}) {
    await this.disconnect(name);
    return await this.connect(name, endpoint, options);
  }

  /**
   * Get status of all connections
   *
   * @returns {Array} - Connection status for each server
   */
  getStatus() {
    const status = [];
    for (const [name, client] of this.clients) {
      const tools = this.tools.get(name) || [];
      status.push({
        name,
        connected: true,
        tools: tools.length,
        toolNames: tools.map(t => t.name),
      });
    }
    return status;
  }
}

// Singleton instance for Gateway-wide use
let instance = null;

/**
 * Get the global MCP client manager instance
 *
 * @returns {MCPClientManager}
 */
export function getMCPClientManager() {
  if (!instance) {
    instance = new MCPClientManager();
  }
  return instance;
}

/**
 * Initialize MCP clients from config
 *
 * @param {Object} mcpConfig - MCP servers configuration from jobs.json
 * @param {Object} [authProviders] - Map of server name → auth provider instance
 * @returns {Promise<MCPClientManager>}
 */
export async function initMCPClients(mcpConfig = {}, authProviders = {}) {
  const manager = getMCPClientManager();
  const runtimeMCPConfig = filterRuntimeMCPServers(mcpConfig);

  for (const [name, config] of Object.entries(runtimeMCPConfig)) {
    try {
      // Build connection config
      const connectConfig = expandConnectionConfig(config);

      if (!connectConfig.endpoint && !connectConfig.command) {
        console.warn(`[MCP] Skipping server without endpoint or command: ${name}`);
        continue;
      }

      // Add auth provider if available
      if (authProviders[name]) {
        connectConfig.authProvider = authProviders[name];
      }

      // Connect using unified interface (handles both HTTP and stdio)
      await manager.connect(name, connectConfig);
    } catch (err) {
      console.error(`[MCP] Failed to connect to ${name}: ${err.message}`);
      // Don't fail Gateway startup if MCP server isn't available
      // Tool calls will fail gracefully with "not connected" error
    }
  }

  return manager;
}
