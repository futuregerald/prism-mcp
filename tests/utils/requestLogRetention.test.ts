import { describe, it, expect, afterEach } from "vitest";
import { dirname } from "node:path";
import { createTestDb } from "../helpers/fixtures.js";
import { getStorage, closeStorage } from "../../src/storage/index.js";
import { startRequestLogRetention, stopRequestLogRetention } from "../../src/requestLogRetention.js";

describe("prism_request_log retention (B2)", () => {
  const originalScheduler = process.env.PRISM_SCHEDULER_ENABLED;
  const originalDataDir = process.env.PRISM_DATA_DIR;

  afterEach(async () => {
    stopRequestLogRetention();
    await closeStorage();
    if (originalScheduler !== undefined) process.env.PRISM_SCHEDULER_ENABLED = originalScheduler;
    else delete process.env.PRISM_SCHEDULER_ENABLED;
    if (originalDataDir !== undefined) process.env.PRISM_DATA_DIR = originalDataDir;
    else delete process.env.PRISM_DATA_DIR;
  });

  it("sweeps rows older than 10 minutes on its own interval, regardless of PRISM_SCHEDULER_ENABLED", async () => {
    const { dbPath, cleanup } = await createTestDb("request-log-retention");
    try {
      process.env.PRISM_DATA_DIR = dirname(dbPath);
      process.env.PRISM_SCHEDULER_ENABLED = "false";
      await closeStorage();
      const storage = await getStorage();

      const now = Date.now();
      const elevenMinAgo = now - 11 * 60 * 1000;
      const fiveMinAgo = now - 5 * 60 * 1000;

      await (storage as any).db.execute({
        sql: `INSERT INTO prism_request_log (key, args_hash, status, owner, response, created_at, updated_at)
              VALUES (?, '', 'done', '', '{}', ?, ?)`,
        args: ["retention-old-key", elevenMinAgo, elevenMinAgo],
      });
      await (storage as any).db.execute({
        sql: `INSERT INTO prism_request_log (key, args_hash, status, owner, response, created_at, updated_at)
              VALUES (?, '', 'done', '', '{}', ?, ?)`,
        args: ["retention-fresh-key", fiveMinAgo, fiveMinAgo],
      });

      startRequestLogRetention(50);

      const deadline = Date.now() + 3000;
      let oldGone = false;
      while (Date.now() < deadline) {
        const row = await storage.getRequestLogRow("retention-old-key");
        if (!row) {
          oldGone = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }

      expect(oldGone).toBe(true);
      const freshRow = await storage.getRequestLogRow("retention-fresh-key");
      expect(freshRow).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  it("never sweeps a pending row, even once it is older than the retention window", async () => {
    const { dbPath, cleanup } = await createTestDb("request-log-retention-pending");
    try {
      process.env.PRISM_DATA_DIR = dirname(dbPath);
      process.env.PRISM_SCHEDULER_ENABLED = "false";
      await closeStorage();
      const storage = await getStorage();

      const elevenMinAgo = Date.now() - 11 * 60 * 1000;
      await (storage as any).db.execute({
        sql: `INSERT INTO prism_request_log (key, args_hash, status, owner, response, created_at, updated_at)
              VALUES (?, '', 'pending', 'owner-1', NULL, ?, ?)`,
        args: ["retention-old-pending-key", elevenMinAgo, elevenMinAgo],
      });

      startRequestLogRetention(50);
      await new Promise(resolve => setTimeout(resolve, 300));

      const row = await storage.getRequestLogRow("retention-old-pending-key");
      expect(row).not.toBeNull();
      expect(row?.status).toBe("pending");
    } finally {
      cleanup();
    }
  });
});
