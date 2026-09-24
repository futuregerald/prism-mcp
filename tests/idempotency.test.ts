import { describe, it, expect, afterEach } from "vitest";
import type { RequestLogRow } from "../src/storage/interface.js";
import {
  runIdempotent,
  getIdempotencyInstanceId,
  computeArgsHash,
  _setPollCapsForTest,
  _resetPollCapsForTest,
  type IdempotencyStorage,
} from "../src/idempotency.js";

class FakeIdempotencyStorage implements IdempotencyStorage {
  rows = new Map<string, RequestLogRow>();
  alwaysFailReclaim = false;

  async getRequestLogRow(key: string): Promise<RequestLogRow | null> {
    return this.rows.get(key) ?? null;
  }

  async insertPendingRequestLog(key: string, argsHash: string, owner: string): Promise<boolean> {
    if (this.rows.has(key)) return false;
    this.rows.set(key, {
      key,
      argsHash,
      status: "pending",
      owner,
      response: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return true;
  }

  async completeRequestLog(key: string, response: string): Promise<void> {
    const row = this.rows.get(key);
    if (row) {
      row.status = "done";
      row.response = response;
    }
  }

  async deleteRequestLog(key: string): Promise<void> {
    this.rows.delete(key);
  }

  async reclaimRequestLog(key: string, fromOwner: string, toOwner: string): Promise<boolean> {
    if (this.alwaysFailReclaim) return false;
    const row = this.rows.get(key);
    if (row && row.status === "pending" && row.owner === fromOwner) {
      row.owner = toOwner;
      return true;
    }
    return false;
  }
}

describe("runIdempotent poll cap (D7)", () => {
  afterEach(() => {
    _resetPollCapsForTest();
  });

  it("keeps polling past the short cross-daemon cap when the pending row is owned by this same instance", async () => {
    const storage = new FakeIdempotencyStorage();
    _setPollCapsForTest(150, 2000);

    const ownerId = getIdempotencyInstanceId();
    const argsHash = computeArgsHash("toolName", {});
    await storage.insertPendingRequestLog("same-owner-key", argsHash, ownerId);

    setTimeout(() => {
      void storage.completeRequestLog("same-owner-key", JSON.stringify({ ok: true }));
    }, 400);

    const result = await runIdempotent(storage, "same-owner-key", "toolName", {}, async () => {
      throw new Error("should not run — the row is already pending");
    });

    expect(result).toEqual({ ok: true });
  });

  it("gives up at the short cap when a different, unreclaimable owner never finishes", async () => {
    const storage = new FakeIdempotencyStorage();
    storage.alwaysFailReclaim = true;
    _setPollCapsForTest(150, 2000);

    const argsHash = computeArgsHash("toolName", {});
    await storage.insertPendingRequestLog("other-owner-key", argsHash, "some-other-daemon-instance");

    const started = Date.now();
    const result: any = await runIdempotent(storage, "other-owner-key", "toolName", {}, async () => {
      throw new Error("should not run — reclaim always fails in this test");
    });
    const elapsedMs = Date.now() - started;

    expect(elapsedMs).toBeLessThan(1000);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("still in progress");
  });
});
