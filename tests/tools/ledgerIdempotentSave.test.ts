import { describe, it, expect, afterEach } from "vitest";
import { dirname } from "node:path";
import { createTestDb } from "../helpers/fixtures.js";
import { getStorage, closeStorage } from "../../src/storage/index.js";
import { runWithRequestContext } from "../../src/utils/requestContext.js";
import { sessionSaveLedgerHandler } from "../../src/tools/ledgerHandlers.js";

describe("session_save_ledger idempotent-id constraint handling (B5)", () => {
  const originalDataDir = process.env.PRISM_DATA_DIR;

  afterEach(async () => {
    await closeStorage();
    if (originalDataDir !== undefined) process.env.PRISM_DATA_DIR = originalDataDir;
    else delete process.env.PRISM_DATA_DIR;
  });

  it("a retry that hits the deterministic-id constraint returns the REAL stored row, not a fabricated placeholder", async () => {
    const { dbPath, cleanup } = await createTestDb("ledger-idempotent-save");
    try {
      process.env.PRISM_DATA_DIR = dirname(dbPath);
      await closeStorage();
      await getStorage();

      const args = {
        project: "b5-idempotent-project",
        conversation_id: "conv-b5",
        summary: "The real, original summary text",
      };

      const first: any = await runWithRequestContext({ idempotencyKey: "b5-client:save-1" }, () =>
        sessionSaveLedgerHandler(args)
      );
      expect(first.isError).toBeFalsy();

      const second: any = await runWithRequestContext({ idempotencyKey: "b5-client:save-1" }, () =>
        sessionSaveLedgerHandler(args)
      );
      expect(second.isError).toBeFalsy();
      expect(second.content[0].text).toContain("The real, original summary text");
      expect(second.content[0].text).not.toContain("undefined");
    } finally {
      cleanup();
    }
  });

  it("a constraint-shaped error with no matching row still rethrows instead of pretending success", async () => {
    const { dbPath, cleanup } = await createTestDb("ledger-idempotent-rethrow");
    try {
      process.env.PRISM_DATA_DIR = dirname(dbPath);
      await closeStorage();
      const storage = await getStorage();

      const originalSaveLedger = storage.saveLedger.bind(storage);
      (storage as any).saveLedger = async () => {
        throw new Error("UNIQUE constraint failed: session_ledger.id (simulated, unrelated row)");
      };

      try {
        await expect(
          runWithRequestContext({ idempotencyKey: "b5-client:save-2" }, () =>
            sessionSaveLedgerHandler({
              project: "b5-rethrow-project",
              conversation_id: "conv-b5-rethrow",
              summary: "Should rethrow because no row with this id actually exists",
            })
          )
        ).rejects.toThrow(/UNIQUE constraint/);
      } finally {
        (storage as any).saveLedger = originalSaveLedger;
      }
    } finally {
      cleanup();
    }
  });
});
