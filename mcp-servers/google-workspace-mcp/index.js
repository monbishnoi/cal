#!/usr/bin/env node
/**
 * Google Workspace MCP wrapper for CAL Phase 1.
 *
 * Uses Google's open-source `gws` CLI for Workspace API access while exposing
 * only the Drive/Docs tools approved for the first CAL integration phase.
 */

import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const GWS_BIN = process.env.GWS_BIN || "gws";
const WRITE_CONFIRMATION_TTL_MS = Number(process.env.GWS_WRITE_CONFIRMATION_TTL_MS || 10 * 60 * 1000);
const MAX_OUTPUT_BYTES = Number(process.env.GWS_MAX_OUTPUT_BYTES || 10 * 1024 * 1024);
const FORBIDDEN_BATCH_REQUESTS = new Set([
  "deleteContentRange",
  "deleteParagraphBullets",
  "deletePositionedObject",
  "deleteTableColumn",
  "deleteTableRow",
]);

const pendingWrites = new Map();

const tools = [
  {
    name: "google_drive_search_docs",
    description: "Search Google Drive for Google Docs only. Read-only; excludes trashed files.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Text to match against document name or full text. Omit for recent docs.",
        },
        pageSize: {
          type: "number",
          description: "Maximum results to return. Defaults to 10; capped at 50.",
        },
      },
    },
  },
  {
    name: "google_docs_read",
    description: "Read a Google Docs document by document ID. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: {
          type: "string",
          description: "Google Docs document ID.",
        },
        includeRaw: {
          type: "boolean",
          description: "Include the raw Google Docs API response in addition to extracted text.",
        },
      },
      required: ["documentId"],
    },
  },
  {
    name: "google_docs_create",
    description: "Create a Google Docs document. Write confirmation token required before execution.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Title for the new Google Docs document.",
        },
        initialText: {
          type: "string",
          description: "Optional text inserted at the start of the document after creation.",
        },
        approvalToken: {
          type: "string",
          description: "Token returned by the first confirmation-required response.",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "google_docs_batch_update",
    description: "Run a non-destructive Google Docs batchUpdate request. Write confirmation token required before execution.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: {
          type: "string",
          description: "Google Docs document ID.",
        },
        requests: {
          type: "array",
          description: "Google Docs batchUpdate requests. Destructive delete requests are blocked in Phase 1.",
          items: {
            type: "object",
          },
        },
        approvalToken: {
          type: "string",
          description: "Token returned by the first confirmation-required response.",
        },
      },
      required: ["documentId", "requests"],
    },
  },
];

function jsonText(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function parseJsonMaybe(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function compactErrorOutput(text) {
  return text
    .split("\n")
    .filter(line => line.trim())
    .slice(-20)
    .join("\n");
}

function runGws(args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(GWS_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`gws command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", chunk => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        reject(new Error(`gws output exceeded ${MAX_OUTPUT_BYTES} bytes`));
        return;
      }
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", chunk => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", err => {
      clearTimeout(timeout);
      if (err.code === "ENOENT") {
        reject(new Error("gws CLI is not installed or not on PATH. Install @googleworkspace/cli, then run `gws auth setup` and `gws auth login`."));
      } else {
        reject(err);
      }
    });

    child.on("close", code => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`gws exited with code ${code}: ${compactErrorOutput(stderr || stdout)}`));
        return;
      }
      resolve(parseJsonMaybe(stdout));
    });
  });
}

function escapeDriveQueryLiteral(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function safePageSize(value) {
  const n = Number(value || 10);
  if (!Number.isFinite(n)) return 10;
  return Math.max(1, Math.min(Math.trunc(n), 50));
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function withoutApprovalToken(args = {}) {
  const clean = { ...args };
  delete clean.approvalToken;
  return clean;
}

function writeFingerprint(toolName, args) {
  return createHash("sha256")
    .update(stableStringify({ toolName, args: withoutApprovalToken(args) }))
    .digest("hex");
}

function pruneExpiredWriteTokens() {
  const now = Date.now();
  for (const [token, pending] of pendingWrites) {
    if (pending.expiresAt <= now) {
      pendingWrites.delete(token);
    }
  }
}

async function requireWriteConfirmation(toolName, args, summary, execute) {
  pruneExpiredWriteTokens();

  const approvalToken = typeof args.approvalToken === "string" ? args.approvalToken.trim() : "";
  const fingerprint = writeFingerprint(toolName, args);

  if (!approvalToken) {
    const token = randomBytes(16).toString("hex");
    const expiresAt = Date.now() + WRITE_CONFIRMATION_TTL_MS;
    pendingWrites.set(token, { fingerprint, toolName, summary, expiresAt });

    return {
      status: "write_confirmation_required",
      message: "This Google Docs write has not been executed. Confirm with the user, then call the same tool again with approvalToken.",
      toolName,
      summary,
      approvalToken: token,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  const pending = pendingWrites.get(approvalToken);
  if (!pending) {
    return {
      status: "write_rejected",
      message: "Approval token is missing, expired, or unknown. No Google Docs write was executed.",
    };
  }

  if (pending.fingerprint !== fingerprint || pending.toolName !== toolName) {
    return {
      status: "write_rejected",
      message: "Approval token does not match this exact Google Docs write request. No write was executed.",
    };
  }

  pendingWrites.delete(approvalToken);
  return execute();
}

function getDocText(doc) {
  const chunks = [];

  function walkContent(content = []) {
    for (const item of content) {
      if (item.paragraph?.elements) {
        for (const element of item.paragraph.elements) {
          if (element.textRun?.content) chunks.push(element.textRun.content);
        }
      }
      if (item.table?.tableRows) {
        for (const row of item.table.tableRows) {
          for (const cell of row.tableCells || []) {
            walkContent(cell.content || []);
          }
        }
      }
      if (item.tableOfContents?.content) {
        walkContent(item.tableOfContents.content);
      }
    }
  }

  walkContent(doc?.body?.content || []);
  return chunks.join("");
}

function assertNonDestructiveBatchRequests(requests) {
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new Error("requests must be a non-empty array");
  }

  for (const request of requests) {
    const keys = Object.keys(request || {});
    for (const key of keys) {
      if (FORBIDDEN_BATCH_REQUESTS.has(key)) {
        throw new Error(`Batch update request '${key}' is blocked in Phase 1 because deletion is not allowed.`);
      }
    }

    const replacement = request?.replaceAllText?.replaceText;
    if (replacement === "") {
      throw new Error("replaceAllText with an empty replacement is blocked in Phase 1 because it deletes text.");
    }
  }
}

async function searchDocs(args = {}) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const pageSize = safePageSize(args.pageSize);
  const qParts = [
    "mimeType='application/vnd.google-apps.document'",
    "trashed=false",
  ];

  if (query) {
    const literal = escapeDriveQueryLiteral(query);
    qParts.push(`(name contains '${literal}' or fullText contains '${literal}')`);
  }

  const params = {
    pageSize,
    q: qParts.join(" and "),
    fields: "nextPageToken,files(id,name,mimeType,webViewLink,modifiedTime,owners(displayName,emailAddress))",
    orderBy: query ? undefined : "modifiedTime desc",
  };

  Object.keys(params).forEach(key => params[key] === undefined && delete params[key]);

  return runGws(["drive", "files", "list", "--params", JSON.stringify(params)]);
}

async function readDoc(args = {}) {
  if (!args.documentId) throw new Error("documentId is required");

  const doc = await runGws([
    "docs",
    "documents",
    "get",
    "--params",
    JSON.stringify({ documentId: args.documentId }),
  ]);

  const result = {
    documentId: doc?.documentId || args.documentId,
    title: doc?.title,
    text: getDocText(doc),
  };

  if (args.includeRaw) result.raw = doc;
  return result;
}

async function createDoc(args = {}) {
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) throw new Error("title is required");

  const summary = {
    action: "create_google_doc",
    title,
    initialTextChars: typeof args.initialText === "string" ? args.initialText.length : 0,
  };

  return requireWriteConfirmation("google_docs_create", args, summary, async () => {
    const created = await runGws([
      "docs",
      "documents",
      "create",
      "--json",
      JSON.stringify({ title }),
    ]);

    const documentId = created?.documentId;
    const result = { status: "created", document: created };

    if (documentId && args.initialText) {
      result.initialTextUpdate = await runGws([
        "docs",
        "documents",
        "batchUpdate",
        "--params",
        JSON.stringify({ documentId }),
        "--json",
        JSON.stringify({
          requests: [
            {
              insertText: {
                location: { index: 1 },
                text: args.initialText,
              },
            },
          ],
        }),
      ]);
    }

    return result;
  });
}

async function batchUpdateDoc(args = {}) {
  if (!args.documentId) throw new Error("documentId is required");
  assertNonDestructiveBatchRequests(args.requests);

  const summary = {
    action: "batch_update_google_doc",
    documentId: args.documentId,
    requestCount: args.requests.length,
    requestTypes: args.requests.map(request => Object.keys(request || {})[0]).filter(Boolean),
  };

  return requireWriteConfirmation("google_docs_batch_update", args, summary, async () => {
    const update = await runGws([
      "docs",
      "documents",
      "batchUpdate",
      "--params",
      JSON.stringify({ documentId: args.documentId }),
      "--json",
      JSON.stringify({ requests: args.requests }),
    ]);

    return { status: "updated", result: update };
  });
}

const server = new Server(
  { name: "cal-google-workspace-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case "google_drive_search_docs":
        return jsonText(await searchDocs(args));
      case "google_docs_read":
        return jsonText(await readDoc(args));
      case "google_docs_create":
        return jsonText(await createDoc(args));
      case "google_docs_batch_update":
        return jsonText(await batchUpdateDoc(args));
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return jsonText({
      status: "error",
      message: err.message,
    });
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
