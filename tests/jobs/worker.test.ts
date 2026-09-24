import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { createTestDb } from "../helpers/fixtures.js";
import { PRISM_USER_ID } from "../../src/config.js";
import { getStorage, closeStorage } from "../../src/storage/index.js";
import { sessionSaveLedgerHandler } from "../../src/tools/ledgerHandlers.js";
import { _setLLMProviderForTest } from "../../src/utils/llm/factory.js";
import type { LLMProvider } from "../../src/utils/llm/provider.js";
import { startJobWorker, stopJobWorker } from "../../src/jobs/worker.js";

class MockLLM implements LLMProvider {
  async generateText(): Promise<string> {
    return "mock";
  }
  async generateEmbedding(): Promise<number[]> {
    return new Array(768).fill(0.01);
  }
}

class ThrowingLLM implements LLMProvider {
  async generateText(): Promise<string> {
    throw new Error("ThrowingLLM: no API key configured");
  }
  async generateEmbedding(): Promise<number[]> {
    throw new Error("ThrowingLLM: no API key configured");
  }
}

async function getStorageRetryingOnBusy(retries = 20, delayMs = 100) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await getStorage();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("SQLITE_BUSY") || attempt >= retries) throw err;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

describe("session_save_ledger durable embedding job", () => {
  beforeAll(async () => {
    await getStorageRetryingOnBusy();
  });

  it("returns success and leaves a job row even when the embedding provider throws", async () => {
    _setLLMProviderForTest(new ThrowingLLM());

    const project = `job-worker-throw-${randomUUID()}`;
    const result: any = await sessionSaveLedgerHandler({
      project,
      conversation_id: "conv-throw",
      summary: "Save must succeed despite a throwing embedding provider",
    });
    expect(result.isError).toBeFalsy();

    const storage = await getStorage();
    const entries = await storage.getLedgerEntries({
      project: `eq.${project}`,
      conversation_id: "eq.conv-throw",
    } as any);
    expect(entries.length).toBe(1);
    const entryId = (entries[0] as any).id;

    const rows = await (storage as any).db.execute({
      sql: `SELECT * FROM prism_jobs WHERE id = ?`,
      args: [`embed_ledger:${entryId}`],
    });
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].kind).toBe("embed_ledger");
  });
});

describe("job worker crash recovery and startup scan", () => {
  const originalDataDir = process.env.PRISM_DATA_DIR;

  afterEach(async () => {
    await stopJobWorker();
    await closeStorage();
    if (originalDataDir !== undefined) {
      process.env.PRISM_DATA_DIR = originalDataDir;
    } else {
      delete process.env.PRISM_DATA_DIR;
    }
  });

  it("a job enqueued before a simulated crash survives, and a fresh storage's worker completes it", async () => {
    const { storage: storage1, dbPath, cleanup } = await createTestDb("job-worker-crash");
    try {
      const summary = "Entry saved right before a simulated crash";
      const saved = await storage1.saveLedger({
        project: "crash-sim",
        conversation_id: "conv-crash",
        user_id: PRISM_USER_ID,
        summary,
      });
      const entryId = (saved as any)[0].id;
      await storage1.enqueueJob(`embed_ledger:${entryId}`, "embed_ledger", JSON.stringify({ entryId, text: summary }));

      const beforeCrash = await (storage1 as any).db.execute({
        sql: `SELECT * FROM prism_jobs WHERE id = ?`,
        args: [`embed_ledger:${entryId}`],
      });
      expect(beforeCrash.rows.length).toBe(1);

      await storage1.close();

      process.env.PRISM_DATA_DIR = dirname(dbPath);
      await closeStorage();
      const storage2 = await getStorage();

      _setLLMProviderForTest(new MockLLM());
      await startJobWorker({ pollMs: 20 });

      const deadline = Date.now() + 5000;
      let jobGone = false;
      while (Date.now() < deadline) {
        const remaining = await (storage2 as any).db.execute({
          sql: `SELECT * FROM prism_jobs WHERE id = ?`,
          args: [`embed_ledger:${entryId}`],
        });
        if (remaining.rows.length === 0) {
          jobGone = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(jobGone).toBe(true);

      const patched = await storage2.getLedgerEntries({
        project: "eq.crash-sim",
        conversation_id: "eq.conv-crash",
      } as any);
      expect((patched[0] as any).embedding).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  it("startup recovery enqueues a NULL-embedding row's job exactly once across two restarts", async () => {
    const { storage: storage1, dbPath, cleanup } = await createTestDb("job-worker-recovery");
    try {
      const saved = await storage1.saveLedger({
        project: "recovery-sim",
        conversation_id: "conv-recovery",
        user_id: PRISM_USER_ID,
        summary: "Orphaned entry with no embedding and no job row",
      });
      const entryId = (saved as any)[0].id;
      await storage1.close();

      process.env.PRISM_DATA_DIR = dirname(dbPath);
      await closeStorage();
      const storage2 = await getStorage();

      await startJobWorker({ pollMs: 999_999 });
      await stopJobWorker();

      const afterFirst = await (storage2 as any).db.execute({
        sql: `SELECT * FROM prism_jobs WHERE id = ?`,
        args: [`embed_ledger:${entryId}`],
      });
      expect(afterFirst.rows.length).toBe(1);
      expect(afterFirst.rows[0].attempts).toBe(0);

      await startJobWorker({ pollMs: 999_999 });
      await stopJobWorker();

      const afterSecond = await (storage2 as any).db.execute({
        sql: `SELECT * FROM prism_jobs WHERE id = ?`,
        args: [`embed_ledger:${entryId}`],
      });
      expect(afterSecond.rows.length).toBe(1);
      expect(afterSecond.rows[0].attempts).toBe(0);
      expect(afterSecond.rows[0].created_at).toBe(afterFirst.rows[0].created_at);

      const stillUnembedded = await storage2.getLedgerEntries({
        project: "eq.recovery-sim",
        conversation_id: "eq.conv-recovery",
      } as any);
      expect((stillUnembedded[0] as any).embedding).toBeFalsy();
    } finally {
      cleanup();
    }
  });
});
