import { describe, it, expect, afterEach } from "vitest";
import { dirname } from "node:path";
import { createTestDb } from "../helpers/fixtures.js";
import { getStorage, closeStorage } from "../../src/storage/index.js";
import { PRISM_USER_ID } from "../../src/config.js";
import { sessionForgetMemoryHandler } from "../../src/tools/ledgerHandlers.js";
import { knowledgeForgetHandler } from "../../src/tools/graphHandlers.js";
import { deepStoragePurgeHandler } from "../../src/tools/hygieneHandlers.js";

describe("forget/purge tools clean up prism_jobs and prism_request_log (B2)", () => {
  const originalDataDir = process.env.PRISM_DATA_DIR;

  afterEach(async () => {
    await closeStorage();
    if (originalDataDir !== undefined) process.env.PRISM_DATA_DIR = originalDataDir;
    else delete process.env.PRISM_DATA_DIR;
  });

  it("session_forget_memory hard_delete removes the job row and purges request-log rows mentioning the entry", async () => {
    const { dbPath, cleanup } = await createTestDb("forget-hard");
    try {
      process.env.PRISM_DATA_DIR = dirname(dbPath);
      await closeStorage();
      const storage = await getStorage();

      const saved = await storage.saveLedger({
        project: "forget-hard-project",
        conversation_id: "conv-forget-hard",
        user_id: PRISM_USER_ID,
        summary: "Entry to be hard-forgotten",
      });
      const entryId = (saved as any)[0].id;

      await storage.enqueueJob(`embed_ledger:${entryId}`, "embed_ledger", JSON.stringify({ entryId }));
      await storage.insertPendingRequestLog(`cache:${entryId}`, "hash", "owner-1");
      await storage.completeRequestLog(`cache:${entryId}`, JSON.stringify({ content: [{ type: "text", text: `saved id ${entryId}` }] }));

      const result: any = await sessionForgetMemoryHandler({ memory_id: entryId, hard_delete: true });
      expect(result.isError).toBeFalsy();

      const existingJobs = await storage.getExistingJobIds([`embed_ledger:${entryId}`]);
      expect(existingJobs.size).toBe(0);

      const cacheRow = await storage.getRequestLogRow(`cache:${entryId}`);
      expect(cacheRow).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("session_forget_memory soft-delete removes the job row without touching unrelated request-log rows", async () => {
    const { dbPath, cleanup } = await createTestDb("forget-soft");
    try {
      process.env.PRISM_DATA_DIR = dirname(dbPath);
      await closeStorage();
      const storage = await getStorage();

      const saved = await storage.saveLedger({
        project: "forget-soft-project",
        conversation_id: "conv-forget-soft",
        user_id: PRISM_USER_ID,
        summary: "Entry to be soft-forgotten",
      });
      const entryId = (saved as any)[0].id;

      await storage.enqueueJob(`embed_ledger:${entryId}`, "embed_ledger", JSON.stringify({ entryId }));
      await storage.insertPendingRequestLog("unrelated-key", "hash", "owner-1");
      await storage.completeRequestLog("unrelated-key", JSON.stringify({ ok: true }));

      const result: any = await sessionForgetMemoryHandler({ memory_id: entryId, hard_delete: false });
      expect(result.isError).toBeFalsy();

      const existingJobs = await storage.getExistingJobIds([`embed_ledger:${entryId}`]);
      expect(existingJobs.size).toBe(0);

      const unrelatedRow = await storage.getRequestLogRow("unrelated-key");
      expect(unrelatedRow).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  it("knowledge_forget (bulk) removes the job row for every deleted ledger entry", async () => {
    const { dbPath, cleanup } = await createTestDb("knowledge-forget-bulk");
    try {
      process.env.PRISM_DATA_DIR = dirname(dbPath);
      await closeStorage();
      const storage = await getStorage();

      const project = "knowledge-forget-bulk-project";
      const savedOne = await storage.saveLedger({
        project,
        conversation_id: "conv-1",
        user_id: PRISM_USER_ID,
        summary: "First entry",
      });
      const savedTwo = await storage.saveLedger({
        project,
        conversation_id: "conv-2",
        user_id: PRISM_USER_ID,
        summary: "Second entry",
      });
      const idOne = (savedOne as any)[0].id;
      const idTwo = (savedTwo as any)[0].id;

      await storage.enqueueJob(`embed_ledger:${idOne}`, "embed_ledger", JSON.stringify({ entryId: idOne }));
      await storage.enqueueJob(`embed_ledger:${idTwo}`, "embed_ledger", JSON.stringify({ entryId: idTwo }));

      const result: any = await knowledgeForgetHandler({ project });
      expect(result.isError).toBeFalsy();

      const existingJobs = await storage.getExistingJobIds([`embed_ledger:${idOne}`, `embed_ledger:${idTwo}`]);
      expect(existingJobs.size).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("deep_storage_purge (non-dry-run) purges all prism_request_log rows", async () => {
    const { dbPath, cleanup } = await createTestDb("deep-storage-purge");
    try {
      process.env.PRISM_DATA_DIR = dirname(dbPath);
      await closeStorage();
      const storage = await getStorage();

      await storage.insertPendingRequestLog("purge-me", "hash", "owner-1");
      await storage.completeRequestLog("purge-me", JSON.stringify({ ok: true }));

      const result: any = await deepStoragePurgeHandler({ older_than_days: 7, dry_run: false });
      expect(result.isError).toBeFalsy();

      const row = await storage.getRequestLogRow("purge-me");
      expect(row).toBeNull();
    } finally {
      cleanup();
    }
  });
});
