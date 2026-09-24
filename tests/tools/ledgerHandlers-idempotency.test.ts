import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sessionSaveLedgerHandler } from "../../src/tools/ledgerHandlers.js";
import { getStorage } from "../../src/storage/index.js";
import { runWithRequestContext } from "../../src/utils/requestContext.js";
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

describe("session_save_ledger idempotent id (M3)", () => {
  beforeAll(() => {
    _setLLMProviderForTest(new MockLLM());
  });

  it("a repeated idempotencyKey derives the same ledger row id, so a retry hits the PRIMARY KEY and is treated as already-saved", async () => {
    const project = `m3-idempotency-${randomUUID()}`;
    const idempotencyKey = `m3-test:${randomUUID()}`;
    const args = { project, conversation_id: "conv-m3", summary: "M3 direct test save" };

    const first = await runWithRequestContext({ idempotencyKey }, () => sessionSaveLedgerHandler(args));
    expect(first.isError).toBeFalsy();

    const second = await runWithRequestContext({ idempotencyKey }, () => sessionSaveLedgerHandler(args));
    expect(second.isError).toBeFalsy();

    const storage = await getStorage();
    const entries = await storage.getLedgerEntries({
      project: `eq.${project}`,
      conversation_id: "eq.conv-m3",
    } as any);
    expect(entries.length).toBe(1);
  });

  it("a different idempotencyKey for the same args produces a different row", async () => {
    const project = `m3-idempotency-${randomUUID()}`;
    const args = { project, conversation_id: "conv-m3b", summary: "M3 distinct keys" };

    await runWithRequestContext({ idempotencyKey: `key-a-${randomUUID()}` }, () => sessionSaveLedgerHandler(args));
    await runWithRequestContext({ idempotencyKey: `key-b-${randomUUID()}` }, () => sessionSaveLedgerHandler(args));

    const storage = await getStorage();
    const entries = await storage.getLedgerEntries({
      project: `eq.${project}`,
      conversation_id: "eq.conv-m3b",
    } as any);
    expect(entries.length).toBe(2);
  });
});
