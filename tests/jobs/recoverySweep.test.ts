import { describe, it, expect, afterEach } from "vitest";
import { dirname } from "node:path";
import { createTestDb } from "../helpers/fixtures.js";
import { getStorage, closeStorage } from "../../src/storage/index.js";
import { PRISM_USER_ID } from "../../src/config.js";
import { startJobWorker, stopJobWorker } from "../../src/jobs/worker.js";
import { findLedgerEntriesMissingEmbeddings } from "../../src/tools/hygieneHandlers.js";

describe("job worker startup sweep (B6)", () => {
  const originalDataDir = process.env.PRISM_DATA_DIR;

  afterEach(async () => {
    await stopJobWorker();
    await closeStorage();
    if (originalDataDir !== undefined) process.env.PRISM_DATA_DIR = originalDataDir;
    else delete process.env.PRISM_DATA_DIR;
  });

  it("resets attempts and last_error for dead jobs (attempts>=5) at worker start", async () => {
    const { dbPath, cleanup } = await createTestDb("dead-job-reset");
    try {
      process.env.PRISM_DATA_DIR = dirname(dbPath);
      await closeStorage();
      const storage = await getStorage();

      await (storage as any).db.execute({
        sql: `INSERT INTO prism_jobs (id, kind, payload, attempts, run_after, last_error, created_at)
              VALUES (?, 'embed_ledger', '{}', 5, ?, 'boom', ?)`,
        args: ["dead-job-1", Date.now() + 999_999, Date.now()],
      });

      await startJobWorker({ pollMs: 999_999 });
      await stopJobWorker();

      const row = await (storage as any).db.execute({
        sql: `SELECT attempts, last_error, run_after FROM prism_jobs WHERE id = ?`,
        args: ["dead-job-1"],
      });
      expect(row.rows.length).toBe(1);
      expect(row.rows[0].attempts).toBe(0);
      expect(row.rows[0].last_error).toBeNull();
      expect(Number(row.rows[0].run_after)).toBeLessThanOrEqual(Date.now());
    } finally {
      cleanup();
    }
  });

  it("the recovery scan skips rows that already have a job row, reaching rows past the first page", async () => {
    const { dbPath, cleanup } = await createTestDb("recovery-past-200");
    try {
      process.env.PRISM_DATA_DIR = dirname(dbPath);
      await closeStorage();
      const storage = await getStorage();

      const project = "recovery-past-200-project";
      const total = 30;
      for (let i = 0; i < total; i++) {
        await storage.saveLedger({
          project,
          conversation_id: `conv-${i}`,
          user_id: PRISM_USER_ID,
          summary: `Recovery candidate entry ${i}`,
        });
      }

      const allCandidates = await findLedgerEntriesMissingEmbeddings(storage, { limit: total, project });
      expect(allCandidates.length).toBe(total);

      const alreadyQueued = allCandidates.slice(0, total - 5) as any[];
      const shouldBeNewlyQueued = allCandidates.slice(total - 5) as any[];

      for (const entry of alreadyQueued) {
        await storage.enqueueJob(`embed_ledger:${entry.id}`, "embed_ledger", JSON.stringify({ entryId: entry.id }));
      }

      await startJobWorker({ pollMs: 999_999 });
      await stopJobWorker();

      const newIds = shouldBeNewlyQueued.map((e: any) => `embed_ledger:${e.id}`);
      const existing = await storage.getExistingJobIds(newIds);
      expect(existing.size).toBe(newIds.length);
    } finally {
      cleanup();
    }
  });
});
