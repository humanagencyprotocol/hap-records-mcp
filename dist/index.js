#!/usr/bin/env node

// src/index.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

// src/db.ts
import { existsSync, mkdirSync, copyFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
var SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  metadata TEXT DEFAULT '{}',
  tags TEXT DEFAULT '[]',
  archived INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_records_type ON records(type);
CREATE INDEX IF NOT EXISTS idx_records_archived ON records(archived, type);
CREATE INDEX IF NOT EXISTS idx_records_created ON records(created_at);
`;
var FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
  title, content, tags,
  content=records,
  content_rowid=rowid,
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS records_ai AFTER INSERT ON records BEGIN
  INSERT INTO records_fts(rowid, title, content, tags)
  VALUES (new.rowid, new.title, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS records_ad AFTER DELETE ON records BEGIN
  INSERT INTO records_fts(records_fts, rowid, title, content, tags)
  VALUES ('delete', old.rowid, old.title, old.content, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS records_au AFTER UPDATE ON records BEGIN
  INSERT INTO records_fts(records_fts, rowid, title, content, tags)
  VALUES ('delete', old.rowid, old.title, old.content, old.tags);
  INSERT INTO records_fts(rowid, title, content, tags)
  VALUES (new.rowid, new.title, new.content, new.tags);
END;
`;
async function createSqliteDb(dbPath) {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  db.exec(FTS_SCHEMA);
  return {
    async run(sql, params = []) {
      db.prepare(sql).run(...params);
    },
    async get(sql, params = []) {
      return db.prepare(sql).get(...params);
    },
    async all(sql, params = []) {
      return db.prepare(sql).all(...params);
    },
    async close() {
      db.close();
    }
  };
}
async function createPostgresDb(connectionString) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString });
  function adaptSql(sql) {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }
  const pgSchema = SCHEMA.replace(/datetime\('now'\)/g, "NOW()").replace(/CREATE INDEX IF NOT EXISTS/g, "CREATE INDEX IF NOT EXISTS");
  const client = await pool.connect();
  try {
    await client.query(pgSchema);
  } finally {
    client.release();
  }
  return {
    async run(sql, params = []) {
      await pool.query(adaptSql(sql), params);
    },
    async get(sql, params = []) {
      const result = await pool.query(adaptSql(sql), params);
      return result.rows[0];
    },
    async all(sql, params = []) {
      const result = await pool.query(adaptSql(sql), params);
      return result.rows;
    },
    async close() {
      await pool.end();
    }
  };
}
function maybeBackupSqlite(dbPath) {
  const backupPath = dbPath.replace(/\.db$/, ".backup.db");
  if (!existsSync(dbPath)) return;
  const shouldBackup = !existsSync(backupPath) || Date.now() - statSync(backupPath).mtimeMs > 24 * 60 * 60 * 1e3;
  if (shouldBackup) {
    try {
      copyFileSync(dbPath, backupPath);
      console.error(`[records-mcp] backup written to ${backupPath}`);
    } catch (err) {
      console.error(`[records-mcp] backup failed: ${err}`);
    }
  }
}
async function createDb() {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://")) {
    console.error("[records-mcp] using Postgres");
    return createPostgresDb(databaseUrl);
  }
  const hapDir = join(homedir(), ".hap");
  if (!existsSync(hapDir)) {
    mkdirSync(hapDir, { recursive: true });
  }
  const dbPath = databaseUrl || join(hapDir, "records.db");
  maybeBackupSqlite(dbPath);
  console.error(`[records-mcp] using SQLite at ${dbPath}`);
  return createSqliteDb(dbPath);
}

// src/tools/records.ts
import { v4 as uuidv4 } from "uuid";
function parseRecord(row) {
  return {
    ...row,
    tags: (() => {
      try {
        return JSON.parse(row.tags ?? "[]");
      } catch {
        return [];
      }
    })(),
    metadata: (() => {
      try {
        return JSON.parse(row.metadata ?? "{}");
      } catch {
        return {};
      }
    })(),
    archived: row.archived === 1
  };
}
async function create_record(db, args) {
  const { type, title, content, metadata, tags } = args;
  if (!type || !title) {
    throw new Error("'type' and 'title' are required");
  }
  const id = uuidv4();
  await db.run(
    `INSERT INTO records (id, type, title, content, metadata, tags)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      type,
      title,
      content ?? null,
      JSON.stringify(metadata ?? {}),
      JSON.stringify(tags ?? [])
    ]
  );
  const row = await db.get("SELECT * FROM records WHERE id = ?", [id]);
  return parseRecord(row);
}
async function get_record(db, args) {
  const { id } = args;
  if (!id) throw new Error("'id' is required");
  const row = await db.get("SELECT * FROM records WHERE id = ?", [id]);
  if (!row) throw new Error(`Record not found: ${id}`);
  return parseRecord(row);
}
async function list_records(db, args) {
  const { type, archived = false, limit = 50, offset = 0 } = args;
  const conditions = ["archived = ?"];
  const params = [archived ? 1 : 0];
  if (type) {
    conditions.push("type = ?");
    params.push(type);
  }
  const where = `WHERE ${conditions.join(" AND ")}`;
  params.push(limit, offset);
  const rows = await db.all(
    `SELECT * FROM records ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
    params
  );
  return rows.map(parseRecord);
}
async function update_record(db, args) {
  const { id, ...fields } = args;
  if (!id) throw new Error("'id' is required");
  const existing = await db.get(
    "SELECT created_at, title FROM records WHERE id = ?",
    [id]
  );
  if (!existing) throw new Error(`Record not found: ${id}`);
  const ageMs = Date.now() - (/* @__PURE__ */ new Date(existing.created_at + "Z")).getTime();
  if (ageMs > 24 * 60 * 60 * 1e3) {
    throw new Error(
      `Record "${existing.title}" is older than 24 hours and cannot be updated. Create a new record instead.`
    );
  }
  const updatable = ["title", "content", "metadata", "tags"];
  const setClauses = [];
  const params = [];
  for (const key of updatable) {
    if (key in fields) {
      setClauses.push(`${key} = ?`);
      if (key === "tags") {
        params.push(JSON.stringify(fields[key]));
      } else if (key === "metadata") {
        params.push(JSON.stringify(fields[key]));
      } else if (key === "archived") {
        params.push(fields[key] ? 1 : 0);
      } else {
        params.push(fields[key]);
      }
    }
  }
  if (setClauses.length === 0) {
    throw new Error("No fields to update");
  }
  setClauses.push("updated_at = datetime('now')");
  params.push(id);
  await db.run(
    `UPDATE records SET ${setClauses.join(", ")} WHERE id = ?`,
    params
  );
  const row = await db.get("SELECT * FROM records WHERE id = ?", [id]);
  if (!row) throw new Error(`Record not found: ${id}`);
  return parseRecord(row);
}
async function delete_record(db, args) {
  const { id } = args;
  if (!id) throw new Error("'id' is required");
  const row = await db.get(
    "SELECT id, title, created_at FROM records WHERE id = ?",
    [id]
  );
  if (!row) throw new Error(`Record not found: ${id}`);
  const ageMs = Date.now() - (/* @__PURE__ */ new Date(row.created_at + "Z")).getTime();
  if (ageMs > 24 * 60 * 60 * 1e3) {
    throw new Error(
      `Record "${row.title}" is older than 24 hours and cannot be deleted. Use archive_record instead.`
    );
  }
  await db.run("DELETE FROM records WHERE id = ?", [id]);
  return { message: `Record "${row.title}" (${id}) deleted.` };
}
async function archive_record(db, args) {
  const { id } = args;
  if (!id) throw new Error("'id' is required");
  await db.run(
    "UPDATE records SET archived = 1, updated_at = datetime('now') WHERE id = ?",
    [id]
  );
  const row = await db.get("SELECT * FROM records WHERE id = ?", [id]);
  if (!row) throw new Error(`Record not found: ${id}`);
  return parseRecord(row);
}

// src/tools/search.ts
async function search_records(db, args) {
  const { query, type, tags, archived = false, limit = 20 } = args;
  if (!query) throw new Error("'query' is required");
  const isSqlite = await db.get("SELECT 1 as x FROM records_fts LIMIT 0").then(() => true).catch(() => false);
  if (isSqlite) {
    return searchSqlite(db, query, type, tags, archived, limit);
  } else {
    return searchPostgres(db, query, type, tags, archived, limit);
  }
}
async function searchSqlite(db, query, type, tags, archived, limit) {
  const conditions = ["r.archived = ?"];
  const params = [archived ? 1 : 0];
  if (type) {
    conditions.push("r.type = ?");
    params.push(type);
  }
  const where = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";
  params.unshift(query);
  params.push(limit);
  let rows = await db.all(
    `SELECT r.*, rank
     FROM records_fts fts
     JOIN records r ON r.rowid = fts.rowid
     WHERE records_fts MATCH ? ${where}
     ORDER BY rank
     LIMIT ?`,
    params
  );
  if (tags && tags.length > 0) {
    rows = rows.filter((row) => {
      try {
        const rowTags = JSON.parse(row.tags ?? "[]");
        return tags.every((t) => rowTags.includes(t));
      } catch {
        return false;
      }
    });
  }
  return rows.map((row) => ({
    ...row,
    tags: (() => {
      try {
        return JSON.parse(row.tags ?? "[]");
      } catch {
        return [];
      }
    })(),
    metadata: (() => {
      try {
        return JSON.parse(row.metadata ?? "{}");
      } catch {
        return {};
      }
    })(),
    archived: row.archived === 1
  }));
}
async function searchPostgres(db, query, type, tags, archived, limit) {
  const conditions = [
    "archived = ?",
    "(title ILIKE ? OR content ILIKE ?)"
  ];
  const like = `%${query}%`;
  const params = [archived ? 1 : 0, like, like];
  if (type) {
    conditions.push("type = ?");
    params.push(type);
  }
  const where = `WHERE ${conditions.join(" AND ")}`;
  params.push(limit);
  const rows = await db.all(
    `SELECT * FROM records ${where} ORDER BY updated_at DESC LIMIT ?`,
    params
  );
  let results = rows.map((row) => ({
    ...row,
    tags: (() => {
      try {
        return JSON.parse(row.tags ?? "[]");
      } catch {
        return [];
      }
    })(),
    metadata: (() => {
      try {
        return JSON.parse(row.metadata ?? "{}");
      } catch {
        return {};
      }
    })(),
    archived: row.archived === 1
  }));
  if (tags && tags.length > 0) {
    results = results.filter(
      (row) => tags.every((t) => row.tags.includes(t))
    );
  }
  return results;
}

// src/tools/export.ts
async function export_records(db, _args) {
  const rows = await db.all("SELECT * FROM records ORDER BY created_at ASC");
  return {
    records: rows,
    count: rows.length,
    exported_at: (/* @__PURE__ */ new Date()).toISOString()
  };
}

// src/index.ts
var TOOL_DEFINITIONS = [
  // --- Search ---
  {
    name: "search_records",
    description: "Full-text search across all records. Returns matching records ranked by relevance. Use this to find information previously stored on behalf of the user.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms" },
        type: {
          type: "string",
          enum: ["note", "decision", "research", "bookmark", "reference"],
          description: "Limit search to a specific record type"
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Filter to records with ALL of these tags"
        },
        archived: {
          type: "boolean",
          description: "Include archived records (default: false)"
        },
        limit: { type: "number", description: "Max results (default: 20)" }
      },
      required: ["query"]
    }
  },
  // --- Read ---
  {
    name: "get_record",
    description: "Get a single record by ID",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Record ID" }
      },
      required: ["id"]
    }
  },
  {
    name: "list_records",
    description: "List records, optionally filtered by type. Returns most recently updated first.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["note", "decision", "research", "bookmark", "reference"],
          description: "Filter by record type"
        },
        archived: {
          type: "boolean",
          description: "Show archived records (default: false)"
        },
        limit: { type: "number", description: "Max results (default: 50)" },
        offset: { type: "number", description: "Offset for pagination (default: 0)" }
      },
      required: []
    }
  },
  // --- Write ---
  {
    name: "create_record",
    description: "Create a new record to store information on behalf of the user. Types: note (ideas, meeting notes, summaries), decision (choices with rationale), research (findings, analysis), bookmark (URLs, references), reference (documents, templates).",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["note", "decision", "research", "bookmark", "reference"],
          description: "Record type"
        },
        title: { type: "string", description: "Record title" },
        content: {
          type: "string",
          description: "Record content (markdown). For decisions, include rationale and alternatives."
        },
        metadata: {
          type: "object",
          description: "Structured metadata (varies by type). Examples: { url: '...' } for bookmarks, { outcome: '...', alternatives: [...] } for decisions, { source: '...' } for research."
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for categorization and retrieval"
        }
      },
      required: ["type", "title"]
    }
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
          enum: ["note", "decision", "research", "bookmark", "reference"]
        }
      },
      required: ["id"]
    }
  },
  {
    name: "delete_record",
    description: "Permanently delete a record. Only records created within the last 24 hours can be deleted. For older records, use archive_record instead.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Record ID" }
      },
      required: ["id"]
    }
  },
  {
    name: "archive_record",
    description: "Archive a record. Archived records are hidden from default queries but can still be searched with archived=true.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Record ID" }
      },
      required: ["id"]
    }
  },
  // --- Export ---
  {
    name: "export_records",
    description: "Export all records as JSON",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  }
];
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
    const safeArgs = args ?? {};
    try {
      let result;
      switch (name) {
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
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[records-mcp] tool error (${name}):`, message);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: message }, null, 2)
          }
        ],
        isError: true
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
