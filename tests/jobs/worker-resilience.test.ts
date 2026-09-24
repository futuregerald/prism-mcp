import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { createTestDb } from "../helpers/fixtures.js";
import { getStorage, closeStorage } from "../../src/storage/index.js";
import { _setLLMProviderForTest } from "../../src/utils/llm/factory.js";
import type { LLMProvider } from "../../src/utils/llm/provider.js";
import { startJobWorker, stopJobWorker, registerJobHandler } from "../../src/jobs/worker.js";
import { runWithRequestContext, requestContext } from "../../src/utils/requestContext.js";

class MockLLM implements LLMProvider {
  async generateText(): Promise<string> {
    return "mock";
  }
  async generateEmbedding(): Promise<number[]> {
    return new Array(768).fill(0.01);
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

describe("job worker resilience (B3)", () => {
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

  it("a poll cycle that throws does not kill the worker — the next job still gets processed", async () => {
    const { dbPath, cleanup } = await createTestDb("worker-resilience-throw");
    try {
      process.env.PRISM_DATA_DIR = dirname(dbPath);
      await closeStorage();
      const storage = await getStorageRetryingOnBusy();
      _setLLMProviderForTest(new MockLLM());

      const saved = await storage.saveLedger({
        project: "worker-resilience",
        conversation_id: "conv-throw-once",
        user_id: "default",
        summary: "Entry that should still get embedded despite one throwing poll cycle",
      });
      const entryId = (saved as any)[0].id;
      await storage.enqueueJob(`embed_ledger:${entryId}`, "embed_ledger", JSON.stringify({ entryId }));

      const originalClaimNextJob = storage.claimNextJob.bind(storage);
      let hasThrown = false;
      (storage as any).claimNextJob = async (...args: Parameters<typeof originalClaimNextJob>) => {
        if (!hasThrown) {
          hasThrown = true;
          throw new Error("simulated claimNextJob failure");
        }
        return originalClaimNextJob(...args);
      };

      const unhandledRejections: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandledRejections.push(reason);
      process.on("unhandledRejection", onUnhandled);

      try {
        await startJobWorker({ pollMs: 30 });

        const deadline = Date.now() + 5000;
        let embedded = false;
        while (Date.now() < deadline) {
          const remaining = await (storage as any).db.execute({
            sql: `SELECT * FROM prism_jobs WHERE id = ?`,
            args: [`embed_ledger:${entryId}`],
          });
          if (remaining.rows.length === 0) {
            embedded = true;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 25));
        }

        expect(hasThrown).toBe(true);
        expect(embedded).toBe(true);
        expect(unhandledRejections).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    } finally {
      cleanup();
    }
  });

  it("a job kicked from inside a request context does not leak that context into the timer's job execution", async () => {
    const { dbPath, cleanup } = await createTestDb("worker-resilience-context-leak");
    try {
      process.env.PRISM_DATA_DIR = dirname(dbPath);
      await closeStorage();
      const storage = await getStorageRetryingOnBusy();

      let seenContextDuringJob: unknown = "not-run";
      registerJobHandler("test_context_probe", async () => {
        seenContextDuringJob = requestContext();
      });

      await storage.enqueueJob(`probe:${randomUUID()}`, "test_context_probe", "{}");

      await runWithRequestContext({ clientId: "leaking-client", cwd: "/tmp/leak" }, async () => {
        await startJobWorker({ pollMs: 20 });
      });

      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && seenContextDuringJob === "not-run") {
        await new Promise(resolve => setTimeout(resolve, 25));
      }

      expect(seenContextDuringJob).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});
