import type { Db } from "../db.js";

interface FtsRow {
  id: string;
  type: string;
  title: string;
  content: string | null;
  metadata: string;
  tags: string;
  archived: number;
  created_at: string;
  updated_at: string;
  rank: number;
}

export async function search_records(db: Db, args: Record<string, any>) {
  const { query, type, tags, archived = false, limit = 20 } = args;

  if (!query) throw new Error("'query' is required");

  // Check if we're using SQLite (FTS5 available) or Postgres (ILIKE fallback)
  const isSqlite = await db.get<{ x: number }>("SELECT 1 as x FROM records_fts LIMIT 0")
    .then(() => true)
    .catch(() => false);

  if (isSqlite) {
    return searchSqlite(db, query, type, tags, archived, limit);
  } else {
    return searchPostgres(db, query, type, tags, archived, limit);
  }
}

async function searchSqlite(
  db: Db,
  query: string,
  type: string | undefined,
  tags: string[] | undefined,
  archived: boolean,
  limit: number,
) {
  const conditions: string[] = ["r.archived = ?"];
  const params: any[] = [archived ? 1 : 0];

  if (type) {
    conditions.push("r.type = ?");
    params.push(type);
  }

  const where = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";

  // FTS5 match query
  params.unshift(query);
  params.push(limit);

  let rows = await db.all<FtsRow>(
    `SELECT r.*, rank
     FROM records_fts fts
     JOIN records r ON r.rowid = fts.rowid
     WHERE records_fts MATCH ? ${where}
     ORDER BY rank
     LIMIT ?`,
    params
  );

  // Filter by tags in application layer (simpler than JSON parsing in SQL)
  if (tags && tags.length > 0) {
    rows = rows.filter(row => {
      try {
        const rowTags: string[] = JSON.parse(row.tags ?? "[]");
        return tags.every(t => rowTags.includes(t));
      } catch {
        return false;
      }
    });
  }

  return rows.map(row => ({
    ...row,
    tags: (() => { try { return JSON.parse(row.tags ?? "[]"); } catch { return []; } })(),
    metadata: (() => { try { return JSON.parse(row.metadata ?? "{}"); } catch { return {}; } })(),
    archived: row.archived === 1,
  }));
}

async function searchPostgres(
  db: Db,
  query: string,
  type: string | undefined,
  tags: string[] | undefined,
  archived: boolean,
  limit: number,
) {
  const conditions: string[] = [
    "archived = ?",
    "(title ILIKE ? OR content ILIKE ?)",
  ];
  const like = `%${query}%`;
  const params: any[] = [archived ? 1 : 0, like, like];

  if (type) {
    conditions.push("type = ?");
    params.push(type);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  params.push(limit);

  const rows = await db.all<FtsRow>(
    `SELECT * FROM records ${where} ORDER BY updated_at DESC LIMIT ?`,
    params
  );

  let results = rows.map(row => ({
    ...row,
    tags: (() => { try { return JSON.parse(row.tags ?? "[]"); } catch { return []; } })(),
    metadata: (() => { try { return JSON.parse(row.metadata ?? "{}"); } catch { return {}; } })(),
    archived: row.archived === 1,
  }));

  if (tags && tags.length > 0) {
    results = results.filter(row =>
      tags.every(t => (row.tags as string[]).includes(t))
    );
  }

  return results;
}
