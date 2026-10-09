/**
 * Content Provenance §4.1 — the records store persists the authorizing
 * ticket_id on writes, on both fresh and pre-existing databases. The value is
 * still stored in the receipt_id column (internal storage name, unchanged by
 * the v0.7 wire rename of the tool argument receipt_id -> ticket_id).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";
import Database from "better-sqlite3";
import { createDb, type Db } from "../src/db.js";
import { create_record, get_record, update_record } from "../src/tools/records.js";

const RECEIPT = "rcpt-abc-123";

describe("records store — ticket_id provenance (fresh DB)", () => {
  const dbPath = join(tmpdir(), `records-fresh-${process.pid}.db`);
  let db: Db;

  beforeAll(async () => {
    rmSync(dbPath, { force: true });
    process.env.DATABASE_URL = dbPath;
    db = await createDb();
  });
  afterAll(async () => {
    await db.close();
    rmSync(dbPath, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("persists ticket_id on create (into the receipt_id column)", async () => {
    const rec = await create_record(db, { type: "note", title: "T", content: "C", ticket_id: RECEIPT });
    const back = await get_record(db, { id: rec.id });
    expect((back as { receipt_id: string }).receipt_id).toBe(RECEIPT);
  });

  it("updates ticket_id on edit (each version records its authorizer)", async () => {
    const rec = await create_record(db, { type: "note", title: "T2", ticket_id: "rcpt-v1" });
    await update_record(db, { id: rec.id, content: "edited", ticket_id: "rcpt-v2" });
    const back = await get_record(db, { id: rec.id });
    expect((back as { receipt_id: string }).receipt_id).toBe("rcpt-v2");
  });
});

describe("records store — ticket_id migration (pre-existing DB)", () => {
  const dbPath = join(tmpdir(), `records-migrate-${process.pid}.db`);
  let db: Db;

  beforeAll(async () => {
    rmSync(dbPath, { force: true });
    // Simulate an OLD database created before the receipt_id column existed.
    const legacy = new Database(dbPath);
    legacy.exec(`CREATE TABLE records (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, content TEXT,
      metadata TEXT DEFAULT '{}', tags TEXT DEFAULT '[]', archived INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));`);
    legacy.prepare("INSERT INTO records (id, type, title) VALUES (?, ?, ?)").run("old-1", "note", "Legacy");
    legacy.close();

    process.env.DATABASE_URL = dbPath;
    db = await createDb(); // must ALTER TABLE to add receipt_id
  });
  afterAll(async () => {
    await db.close();
    rmSync(dbPath, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("keeps the legacy row readable with a null receipt_id", async () => {
    const back = await get_record(db, { id: "old-1" });
    expect((back as { title: string; receipt_id: string | null }).title).toBe("Legacy");
    expect((back as { receipt_id: string | null }).receipt_id).toBeNull();
  });

  it("persists ticket_id on new writes after migration (into the receipt_id column)", async () => {
    const rec = await create_record(db, { type: "note", title: "New", ticket_id: RECEIPT });
    const back = await get_record(db, { id: rec.id });
    expect((back as { receipt_id: string }).receipt_id).toBe(RECEIPT);
  });
});

describe("tool schema — v0.7 wire rename", () => {
  it("declares ticket_id, not receipt_id, on create_record and update_record's input schema", async () => {
    const { TOOL_DEFINITIONS } = await import("../src/tools/definitions.js");
    for (const name of ["create_record", "update_record"]) {
      const tool = (TOOL_DEFINITIONS as any[]).find((t) => t.name === name)!;
      expect(tool.inputSchema.properties).toHaveProperty("ticket_id");
      expect(tool.inputSchema.properties).not.toHaveProperty("receipt_id");
    }
  });
});
