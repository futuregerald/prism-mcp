import { describe, it, expect, afterEach } from "vitest";
import { createTestDb } from "../helpers/fixtures.js";
import { SqliteStorage } from "../../src/storage/sqlite.js";

describe("prism_jobs storage semantics", () => {
  let cleanupFns: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanupFns) fn();
    cleanupFns = [];
  });

  it("enqueueJob + claimNextJob + completeJob round-trip", async () => {
    const { storage, cleanup } = await createTestDb("prism-jobs-roundtrip");
    cleanupFns.push(cleanup);

    await storage.enqueueJob("job-1", "embed_ledger", JSON.stringify({ entryId: "e1", text: "hello" }));

    const claimed = await storage.claimNextJob(Date.now(), 60_000);
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe("job-1");
    expect(claimed!.kind).toBe("embed_ledger");
    expect(claimed!.attempts).toBe(1);

    const again = await storage.claimNextJob(Date.now(), 60_000);
    expect(again).toBeNull();

    await storage.completeJob("job-1");
    const rows = await (storage as any).db.execute({
      sql: `SELECT * FROM prism_jobs WHERE id = ?`,
      args: ["job-1"],
    });
    expect(rows.rows.length).toBe(0);
  });

  it("enqueueJob is idempotent — a repeated id does not duplicate or reset the row", async () => {
    const { storage, cleanup } = await createTestDb("prism-jobs-idempotent-enqueue");
    cleanupFns.push(cleanup);

    await storage.enqueueJob("job-dup", "embed_ledger", JSON.stringify({ entryId: "e1", text: "first" }));
    await storage.claimNextJob(Date.now(), 60_000);
    await storage.enqueueJob("job-dup", "embed_ledger", JSON.stringify({ entryId: "e1", text: "second" }));

    const rows = await (storage as any).db.execute({
      sql: `SELECT * FROM prism_jobs WHERE id = ?`,
      args: ["job-dup"],
    });
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].attempts).toBe(1);
    expect(rows.rows[0].payload).toBe(JSON.stringify({ entryId: "e1", text: "first" }));
  });

  it("claimNextJob does not return a job whose run_after is in the future", async () => {
    const { storage, cleanup } = await createTestDb("prism-jobs-future");
    cleanupFns.push(cleanup);

    await storage.enqueueJob("job-future", "embed_ledger", JSON.stringify({}));
    await storage.failJob("job-future", "not yet", Date.now() + 60_000);

    const claimed = await storage.claimNextJob(Date.now(), 60_000);
    expect(claimed).toBeNull();
  });

  it("claimNextJob never claims a job with attempts >= 5", async () => {
    const { storage, cleanup } = await createTestDb("prism-jobs-max-attempts");
    cleanupFns.push(cleanup);

    await storage.enqueueJob("job-exhausted", "embed_ledger", JSON.stringify({}));
    for (let i = 0; i < 5; i++) {
      const claimed = await storage.claimNextJob(Date.now(), 0);
      expect(claimed).not.toBeNull();
      await storage.failJob(claimed!.id, `attempt ${i + 1}`, Date.now() - 1);
    }

    const claimed = await storage.claimNextJob(Date.now(), 60_000);
    expect(claimed).toBeNull();

    const rows = await (storage as any).db.execute({
      sql: `SELECT attempts, last_error FROM prism_jobs WHERE id = ?`,
      args: ["job-exhausted"],
    });
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].attempts).toBe(5);
    expect(rows.rows[0].last_error).toBe("attempt 5");
  });

  it("failJob reschedules run_after so the job becomes claimable again once due", async () => {
    const { storage, cleanup } = await createTestDb("prism-jobs-fail-reschedule");
    cleanupFns.push(cleanup);

    await storage.enqueueJob("job-retry", "embed_ledger", JSON.stringify({}));
    const first = await storage.claimNextJob(Date.now(), 0);
    expect(first).not.toBeNull();

    await storage.failJob("job-retry", "boom", Date.now() + 30_000);
    expect(await storage.claimNextJob(Date.now(), 60_000)).toBeNull();

    await storage.failJob("job-retry", "boom", Date.now() - 1);
    const reclaimed = await storage.claimNextJob(Date.now(), 60_000);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.id).toBe("job-retry");
    expect(reclaimed!.last_error).toBe("boom");
  });

  it("two storage instances opened on the same db file never both claim the same job", async () => {
    const { storage: storage1, dbPath, cleanup } = await createTestDb("prism-jobs-race");
    cleanupFns.push(cleanup);

    const storage2 = new SqliteStorage();
    await storage2.initialize(dbPath);

    await storage1.enqueueJob("job-race", "embed_ledger", JSON.stringify({}));

    const [claim1, claim2] = await Promise.all([
      storage1.claimNextJob(Date.now(), 60_000),
      storage2.claimNextJob(Date.now(), 60_000),
    ]);

    const winners = [claim1, claim2].filter((c) => c !== null);
    expect(winners.length).toBe(1);
    expect(winners[0]!.id).toBe("job-race");
  });
});
