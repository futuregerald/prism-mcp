import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { createTestDb } from "../helpers/fixtures.js";
import { getStorage, closeStorage } from "../../src/storage/index.js";
import { sessionSaveLedgerHandler, sessionSaveExperienceHandler } from "../../src/tools/ledgerHandlers.js";
import { BackgroundTaskRegistry } from "../../src/lifecycle.js";
import { _setLLMProviderForTest } from "../../src/utils/llm/factory.js";
import type { LLMProvider } from "../../src/utils/llm/provider.js";

class MockLLM implements LLMProvider {
  async generateText(): Promise<string> {
    return "mock";
  }
  async generateEmbedding(): Promise<number[]> {
    return new Array(768).fill(0.01);
  }
}

describe("embedding job dispatch (D1 + D6)", () => {
  const originalDataDir = process.env.PRISM_DATA_DIR;

  afterEach(async () => {
    await closeStorage();
    if (originalDataDir !== undefined) process.env.PRISM_DATA_DIR = originalDataDir;
    else delete process.env.PRISM_DATA_DIR;
  });

  it("when the backend has no job queue, session_save_ledger generates and patches the embedding directly", async () => {
    const { dbPath, cleanup } = await createTestDb("no-job-queue-ledger");
    try {
      process.env.PRISM_DATA_DIR = dirname(dbPath);
      await closeStorage();
      const storage = await getStorage();
      _setLLMProviderForTest(new MockLLM());

      let enqueueCalled = false;
      const originalEnqueueJob = storage.enqueueJob.bind(storage);
      (storage as any).enqueueJob = async (...args: Parameters<typeof originalEnqueueJob>) => {
        enqueueCalled = true;
        return originalEnqueueJob(...args);
      };
      (storage as any).supportsJobQueue = false;

      const project = `no-job-queue-${randomUUID()}`;
      const result: any = await sessionSaveLedgerHandler({
        project,
        conversation_id: "conv-no-queue",
        summary: "Should embed directly since the backend has no job queue",
      });
      expect(result.isError).toBeFalsy();
      expect(enqueueCalled).toBe(false);

      await BackgroundTaskRegistry.awaitAll(5000);

      const entries = await storage.getLedgerEntries({
        project: `eq.${project}`,
        conversation_id: "eq.conv-no-queue",
      } as any);
      expect(entries.length).toBe(1);
      expect((entries[0] as any).embedding).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  it("when the backend has no job queue, session_save_experience generates and patches the embedding directly", async () => {
    const { dbPath, cleanup } = await createTestDb("no-job-queue-experience");
    try {
      process.env.PRISM_DATA_DIR = dirname(dbPath);
      await closeStorage();
      const storage = await getStorage();
      _setLLMProviderForTest(new MockLLM());

      (storage as any).supportsJobQueue = false;

      const project = `no-job-queue-exp-${randomUUID()}`;
      const result: any = await sessionSaveExperienceHandler({
        project,
        event_type: "learning",
        context: "ctx",
        action: "action",
        outcome: "outcome",
      });
      expect(result.isError).toBeFalsy();

      await BackgroundTaskRegistry.awaitAll(5000);

      const entries = await storage.getLedgerEntries({
        project: `eq.${project}`,
        conversation_id: "eq.experience-event",
      } as any);
      expect(entries.length).toBe(1);
      expect((entries[0] as any).embedding).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  it("a failing enqueueJob does not fail the save — the ledger row is kept and the recovery sweep can retry", async () => {
    const { dbPath, cleanup } = await createTestDb("enqueue-job-fails");
    try {
      process.env.PRISM_DATA_DIR = dirname(dbPath);
      await closeStorage();
      const storage = await getStorage();
      _setLLMProviderForTest(new MockLLM());

      (storage as any).enqueueJob = async () => {
        throw new Error("SQLITE_BUSY: database is locked");
      };

      const project = `enqueue-job-fails-${randomUUID()}`;
      const result: any = await sessionSaveLedgerHandler({
        project,
        conversation_id: "conv-enqueue-fail",
        summary: "Save must succeed even though enqueueJob throws",
      });
      expect(result.isError).toBeFalsy();

      const entries = await storage.getLedgerEntries({
        project: `eq.${project}`,
        conversation_id: "eq.conv-enqueue-fail",
      } as any);
      expect(entries.length).toBe(1);
    } finally {
      cleanup();
    }
  });
});
