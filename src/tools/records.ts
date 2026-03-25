import { v4 as uuidv4 } from "uuid";
import type { Db } from "../db.js";

interface RecordRow {
  id: string;
  type: string;
  title: string;
  content: string | null;
  metadata: string;
  tags: string;
  archived: number;
  created_at: string;
  updated_at: string;
}

function parseRecord(row: RecordRow) {
  return {
    ...row,
    tags: (() => {
      try { return JSON.parse(row.tags ?? "[]"); } catch { return []; }
    })(),
    metadata: (() => {
      try { return JSON.parse(row.metadata ?? "{}"); } catch { return {}; }
    })(),
    archived: row.archived === 1,
  };
}

export async function create_record(db: Db, args: Record<string, any>) {
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
      JSON.stringify(tags ?? []),
    ]
  );

  const row = await db.get<RecordRow>("SELECT * FROM records WHERE id = ?", [id]);
  return parseRecord(row!);
}

export async function get_record(db: Db, args: Record<string, any>) {
  const { id } = args;
  if (!id) throw new Error("'id' is required");

  const row = await db.get<RecordRow>("SELECT * FROM records WHERE id = ?", [id]);
  if (!row) throw new Error(`Record not found: ${id}`);
  return parseRecord(row);
}

export async function list_records(db: Db, args: Record<string, any>) {
  const { type, archived = false, limit = 50, offset = 0 } = args;

  const conditions: string[] = ["archived = ?"];
  const params: any[] = [archived ? 1 : 0];

  if (type) {
    conditions.push("type = ?");
    params.push(type);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  params.push(limit, offset);

  const rows = await db.all<RecordRow>(
    `SELECT * FROM records ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
    params
  );

  return rows.map(parseRecord);
}

export async function update_record(db: Db, args: Record<string, any>) {
  const { id, ...fields } = args;
  if (!id) throw new Error("'id' is required");

  // Check age — records older than 24 hours cannot be updated
  const existing = await db.get<RecordRow>(
    "SELECT created_at, title FROM records WHERE id = ?",
    [id]
  );
  if (!existing) throw new Error(`Record not found: ${id}`);

  const ageMs = Date.now() - new Date(existing.created_at + "Z").getTime();
  if (ageMs > 24 * 60 * 60 * 1000) {
    throw new Error(
      `Record "${existing.title}" is older than 24 hours and cannot be updated. Create a new record instead.`
    );
  }

  const updatable = ["title", "content", "metadata", "tags"];
  const setClauses: string[] = [];
  const params: any[] = [];

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

  const row = await db.get<RecordRow>("SELECT * FROM records WHERE id = ?", [id]);
  if (!row) throw new Error(`Record not found: ${id}`);
  return parseRecord(row);
}

export async function delete_record(db: Db, args: Record<string, any>) {
  const { id } = args;
  if (!id) throw new Error("'id' is required");

  const row = await db.get<RecordRow>(
    "SELECT id, title, created_at FROM records WHERE id = ?",
    [id]
  );
  if (!row) throw new Error(`Record not found: ${id}`);

  // Records older than 24 hours cannot be deleted — use archive_record instead
  const ageMs = Date.now() - new Date(row.created_at + "Z").getTime();
  if (ageMs > 24 * 60 * 60 * 1000) {
    throw new Error(
      `Record "${row.title}" is older than 24 hours and cannot be deleted. Use archive_record instead.`
    );
  }

  await db.run("DELETE FROM records WHERE id = ?", [id]);

  return { message: `Record "${row.title}" (${id}) deleted.` };
}

export async function archive_record(db: Db, args: Record<string, any>) {
  const { id } = args;
  if (!id) throw new Error("'id' is required");

  await db.run(
    "UPDATE records SET archived = 1, updated_at = datetime('now') WHERE id = ?",
    [id]
  );

  const row = await db.get<RecordRow>("SELECT * FROM records WHERE id = ?", [id]);
  if (!row) throw new Error(`Record not found: ${id}`);
  return parseRecord(row);
}
