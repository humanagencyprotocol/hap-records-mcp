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
import { TOOL_DEFINITIONS } from "./tools/definitions.js";

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
