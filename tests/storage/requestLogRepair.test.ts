import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createClient } from "@libsql/client";
import { SqliteStorage } from "../../src/storage/sqlite.js";

const EARLY_SPIKE_REQUEST_LOG_DDL =
  "CREATE TABLE prism_request_log (key TEXT PRIMARY KEY, response TEXT NOT NULL, created_at INTEGER NOT NULL)";

describe("prism_request_log repair for the early spike layout", () => {
  const dirs: string[] = [];
  const storages: SqliteStorage[] = [];

  afterEach(async () => {
    for (const s of storages) await s.close().catch(() => { });
    storages.length = 0;
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("rebuilds the table so pending rows with a NULL response can be written", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-reqlog-"));
    dirs.push(dir);
    const dbPath = path.join(dir, "data.db");

    const seed = createClient({ url: `file:${dbPath}` });
    await seed.execute(EARLY_SPIKE_REQUEST_LOG_DDL);
    seed.close();

    const storage = new SqliteStorage();
    storages.push(storage);
    await storage.initialize(dbPath);

    const columns = await (storage as any).db.execute("PRAGMA table_info(prism_request_log)");
    const names = columns.rows.map((r: any) => r.name).sort();
    expect(names).toEqual(["args_hash", "created_at", "key", "owner", "response", "status", "updated_at"]);
    const response = columns.rows.find((r: any) => r.name === "response");
    expect(Number(response.notnull)).toBe(0);

    await expect(storage.insertPendingRequestLog("client:1", "hash", "owner-1")).resolves.toBe(true);
    const row = await storage.getRequestLogRow("client:1");
    expect(row?.status).toBe("pending");
  });

  it("leaves an already-correct table and its rows alone", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-reqlog-"));
    dirs.push(dir);
    const dbPath = path.join(dir, "data.db");

    const first = new SqliteStorage();
    await first.initialize(dbPath);
    await first.insertPendingRequestLog("client:2", "hash", "owner-1");
    await first.close();

    const second = new SqliteStorage();
    storages.push(second);
    await second.initialize(dbPath);
    const row = await second.getRequestLogRow("client:2");
    expect(row?.status).toBe("pending");
  });
});
