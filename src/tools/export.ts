import type { Db } from "../db.js";

export async function export_records(db: Db, _args: Record<string, any>) {
  const rows = await db.all("SELECT * FROM records ORDER BY created_at ASC");

  return {
    records: rows,
    count: rows.length,
    exported_at: new Date().toISOString(),
  };
}
