#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createDb } from "./db.js";
import { create_record, get_record, list_records, update_record, delete_record, archive_record } from "./tools/records.js";
import { search_records } from "./tools/search.js";
import { export_records } from "./tools/export.js";

const TOOL_DEFINITIONS = [
  // --- Search ---
  {
    name: "search_records",
    description:
      "Full-text search across all records. Returns matching records ranked by relevance. Use this to find information previously stored on behalf of the user.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms" },
        type: {
          type: "string",
          enum: ["note", "decision", "research", "bookmark", "reference"],
          description: "Limit search to a specific record type",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Filter to records with ALL of these tags",
        },
        archived: {
          type: "boolean",
          description: "Include archived records (default: false)",
        },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
      required: ["query"],
    },
  },

  // --- Read ---
  {
    name: "get_record",
    description: "Get a single record by ID",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Record ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "list_records",
    description:
      "List records, optionally filtered by type. Returns most recently updated first.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["note", "decision", "research", "bookmark", "reference"],
          description: "Filter by record type",
        },
        archived: {
          type: "boolean",
          description: "Show archived records (default: false)",
        },
        limit: { type: "number", description: "Max results (default: 50)" },
        offset: { type: "number", description: "Offset for pagination (default: 0)" },
      },
      required: [],
    },
  },

  // --- Write ---
  {
    name: "create_record",
    description:
      "Create a new record to store information on behalf of the user. Types: note (ideas, meeting notes, summaries), decision (choices with rationale), research (findings, analysis), bookmark (URLs, references), reference (documents, templates).",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["note", "decision", "research", "bookmark", "reference"],
          description: "Record type",
        },
        title: { type: "string", description: "Record title" },
        content: {
          type: "string",
          description: "Record content (markdown). For decisions, include rationale and alternatives.",
        },
        metadata: {
          type: "object",
          description:
            "Structured metadata (varies by type). Examples: { url: '...' } for bookmarks, { outcome: '...', alternatives: [...] } for decisions, { source: '...' } for research.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for categorization and retrieval",
        },
      },
      required: ["type", "title"],
    },
  },
  {
    name: "update_record",
    description: "Update fields on an existing record. Only records created within the last 24 hours can be updated. For older records, create a new record instead.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Record ID" },
        title: { type: "string" },
        content: { type: "string" },
        metadata: { type: "object" },
        tags: { type: "array", items: { type: "string" } },
        type: {
          type: "string",
          enum: ["note", "decision", "research", "bookmark", "reference"],
        },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_record",
    description: "Permanently delete a record. Only records created within the last 24 hours can be deleted. For older records, use archive_record instead.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Record ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "archive_record",
    description:
      "Archive a record. Archived records are hidden from default queries but can still be searched with archived=true.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Record ID" },
      },
      required: ["id"],
    },
  },

  // --- Export ---
  {
    name: "export_records",
    description: "Export all records as JSON",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
] as const;

type ToolName = (typeof TOOL_DEFINITIONS)[number]["name"];

async function main() {
  const db = await createDb();

  const server = new Server(
    { name: "records", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOL_DEFINITIONS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const safeArgs = (args ?? {}) as Record<string, any>;

    try {
      let result: unknown;

      switch (name as ToolName) {
        case "search_records":
          result = await search_records(db, safeArgs);
          break;
        case "get_record":
          result = await get_record(db, safeArgs);
          break;
        case "list_records":
          result = await list_records(db, safeArgs);
          break;
        case "create_record":
          result = await create_record(db, safeArgs);
          break;
        case "update_record":
          result = await update_record(db, safeArgs);
          break;
        case "delete_record":
          result = await delete_record(db, safeArgs);
          break;
        case "archive_record":
          result = await archive_record(db, safeArgs);
          break;
        case "export_records":
          result = await export_records(db, safeArgs);
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[records-mcp] tool error (${name}):`, message);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: message }, null, 2),
          },
        ],
        isError: true,
      };
    }
  });

  process.on("SIGINT", async () => {
    await db.close();
    process.exit(0);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[records-mcp] server started");
}

main().catch((err) => {
  console.error("[records-mcp] fatal:", err);
  process.exit(1);
});
