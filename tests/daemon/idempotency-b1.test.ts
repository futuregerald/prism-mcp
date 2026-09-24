import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  ensureDaemonBuilt,
  spawnDaemon,
  waitForSocket,
  killProc,
  getSocketPath,
  connectRawClient,
  helloLine,
  initializeRequest,
  initializedNotification,
} from "./helpers.js";
import { SqliteStorage } from "../../src/storage/sqlite.js";
import { runIdempotent, computeArgsHash } from "../../src/idempotency.js";
import { sessionSaveHandoffHandler } from "../../src/tools/ledgerHandlers.js";

describe("daemon idempotency — B1 clientId-scoped rework", () => {
  let home: string;
  let dataDir: string;
  let proc: ChildProcess;
  let socketPath: string;

  beforeAll(async () => {
    ensureDaemonBuilt();
    home = fs.mkdtempSync(path.join(os.tmpdir(), "prd-b1-"));
    dataDir = home;
    proc = spawnDaemon(home, dataDir, { PRISM_TEST_SAVE_DELAY_MS: "400" });
    socketPath = getSocketPath(dataDir);
    await waitForSocket(socketPath, 15_000);
  }, 30_000);

  afterAll(async () => {
    await killProc(proc);
  });

  async function handshake(clientId: string, cwd = "/tmp/b1-project") {
    const client = await connectRawClient(socketPath);
    client.write(helloLine(cwd, clientId));
    client.send(initializeRequest(1));
    await client.waitFor(1, 15_000);
    client.send(initializedNotification());
    return client;
  }

  it("(a) concurrent duplicate keyed calls run the tool body exactly once and return the same response", async () => {
    const client = await handshake("conc-client");
    const key = "conc-client:dup-1";
    const project = "b1-concurrent";
    const conversationId = "conv-conc";

    try {
      const call = (id: number) => ({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: "session_save_ledger",
          arguments: { project, conversation_id: conversationId, summary: "Concurrent duplicate save" },
          _meta: { "prism/idempotencyKey": key },
        },
      });

      client.send(call(200));
      client.send(call(201));

      const [first, second] = await Promise.all([
        client.waitFor(200, 15_000),
        client.waitFor(201, 15_000),
      ]);

      expect(first.result.isError).toBeFalsy();
      expect(second.result).toEqual(first.result);
    } finally {
      client.close();
    }

    const storage = new SqliteStorage();
    await storage.initialize(path.join(dataDir, "data.db"));
    try {
      const entries = await storage.getLedgerEntries({
        project: `eq.${project}`,
        conversation_id: `eq.${conversationId}`,
      } as any);
      expect(entries.length).toBe(1);
    } finally {
      await storage.close();
    }
  }, 30_000);

  it("(b) a key carrying a DIFFERENT clientId's prefix is ignored — the call runs normally, uncached", async () => {
    const client = await handshake("b-client");
    const mismatchedKey = "someone-else:not-mine";
    const project = "b1-mismatch";
    const conversationId = "conv-mismatch";

    try {
      const call = (id: number) => ({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: "session_save_ledger",
          arguments: { project, conversation_id: conversationId, summary: `Mismatched-key save ${id}` },
          _meta: { "prism/idempotencyKey": mismatchedKey },
        },
      });

      client.send(call(210));
      const first = await client.waitFor(210, 15_000);
      expect(first.result.isError).toBeFalsy();

      client.send(call(211));
      const second = await client.waitFor(211, 15_000);
      expect(second.result.isError).toBeFalsy();
      expect(second.result).not.toEqual(first.result);
    } finally {
      client.close();
    }

    const storage = new SqliteStorage();
    await storage.initialize(path.join(dataDir, "data.db"));
    try {
      const entries = await storage.getLedgerEntries({
        project: `eq.${project}`,
        conversation_id: `eq.${conversationId}`,
      } as any);
      expect(entries.length).toBe(2);

      const row = await storage.getRequestLogRow(mismatchedKey);
      expect(row).toBeNull();
    } finally {
      await storage.close();
    }
  }, 30_000);

  it("(c) the same key reused with different arguments returns an idempotency-conflict error", async () => {
    const client = await handshake("c-client");
    const key = "c-client:reuse-1";

    try {
      client.send({
        jsonrpc: "2.0",
        id: 220,
        method: "tools/call",
        params: {
          name: "session_save_ledger",
          arguments: { project: "b1-conflict", conversation_id: "conv-conflict", summary: "First args" },
          _meta: { "prism/idempotencyKey": key },
        },
      });
      const first = await client.waitFor(220, 15_000);
      expect(first.result.isError).toBeFalsy();

      client.send({
        jsonrpc: "2.0",
        id: 221,
        method: "tools/call",
        params: {
          name: "session_save_ledger",
          arguments: { project: "b1-conflict", conversation_id: "conv-conflict", summary: "DIFFERENT args" },
          _meta: { "prism/idempotencyKey": key },
        },
      });
      const second = await client.waitFor(221, 15_000);
      expect(second.result.isError).toBe(true);
      expect(second.result.content[0].text).toContain("idempotency key reused with different arguments");
    } finally {
      client.close();
    }
  }, 30_000);

  it("(d) a failed tool call is not cached — the pending row is removed so a retry actually runs", async () => {
    const client = await handshake("d-client");
    const key = "d-client:will-fail-1";

    try {
      client.send({
        jsonrpc: "2.0",
        id: 230,
        method: "tools/call",
        params: {
          name: "session_forget_memory",
          arguments: {},
          _meta: { "prism/idempotencyKey": key },
        },
      });
      const failed = await client.waitFor(230, 15_000);
      expect(failed.result.isError).toBe(true);
    } finally {
      client.close();
    }

    const storage = new SqliteStorage();
    await storage.initialize(path.join(dataDir, "data.db"));
    try {
      const row = await storage.getRequestLogRow(key);
      expect(row).toBeNull();
    } finally {
      await storage.close();
    }
  }, 30_000);
});

describe("daemon idempotency — B1 crash recovery (e)", () => {
  it("kill-after-commit: a replay with the same key against a respawned daemon leaves exactly one ledger row", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "prd-b1-crash-"));
    const dataDir = home;
    const socketPath = getSocketPath(dataDir);
    const project = "b1-crash-recovery";
    const conversationId = "conv-crash";
    const key = "e-client:save-1";

    ensureDaemonBuilt();
    let proc = spawnDaemon(home, dataDir, { PRISM_TEST_AFTER_SAVE_DELAY_MS: "2000" });
    await waitForSocket(socketPath, 15_000);

    const sendSave = (client: Awaited<ReturnType<typeof connectRawClient>>, id: number) => {
      client.send({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: "session_save_ledger",
          arguments: { project, conversation_id: conversationId, summary: "Crash recovery save" },
          _meta: { "prism/idempotencyKey": key },
        },
      });
    };

    const firstClient = await connectRawClient(socketPath);
    firstClient.write(helloLine("/tmp/crash-project", "e-client"));
    firstClient.send(initializeRequest(1));
    await firstClient.waitFor(1, 15_000);
    firstClient.send(initializedNotification());
    sendSave(firstClient, 300);

    await new Promise(resolve => setTimeout(resolve, 500));
    proc.kill("SIGKILL");
    await new Promise<void>(resolve => {
      if (proc.exitCode !== null || proc.signalCode !== null) { resolve(); return; }
      proc.once("exit", () => resolve());
    });
    firstClient.close();

    proc = spawnDaemon(home, dataDir, {});
    await waitForSocket(socketPath, 15_000);

    const secondClient = await connectRawClient(socketPath);
    try {
      secondClient.write(helloLine("/tmp/crash-project", "e-client"));
      secondClient.send(initializeRequest(1));
      await secondClient.waitFor(1, 15_000);
      secondClient.send(initializedNotification());
      sendSave(secondClient, 301);
      const replayed = await secondClient.waitFor(301, 15_000);
      expect(replayed.result.isError).toBeFalsy();
    } finally {
      secondClient.close();
      await killProc(proc);
    }

    const storage = new SqliteStorage();
    await storage.initialize(path.join(dataDir, "data.db"));
    try {
      const entries = await storage.getLedgerEntries({
        project: `eq.${project}`,
        conversation_id: `eq.${conversationId}`,
      } as any);
      expect(entries.length).toBe(1);
    } finally {
      await storage.close();
    }
  }, 60_000);
});

describe("daemon idempotency — B1 crash recovery (f), in-process via the done/pending row directly", () => {
  it("session_save_handoff: replaying a reclaimed pending row whose write already landed does not surface a false conflict", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prd-b1-handoff-"));
    const dbPath = path.join(dataDir, "data.db");
    const storage = new SqliteStorage();
    await storage.initialize(dbPath);

    try {
      const project = "b1-handoff-race";
      const key = "f-client:handoff-1";

      await sessionSaveHandoffHandler({ project, last_summary: "v0 baseline" }, undefined as any);

      const replayedArgs = { project, expected_version: 1, last_summary: "First landed summary (v1->v2)" };

      await sessionSaveHandoffHandler(replayedArgs, undefined as any);

      const argsHash = computeArgsHash("session_save_handoff", replayedArgs);
      await storage.insertPendingRequestLog(key, argsHash, "dead-instance");

      const result: any = await runIdempotent(
        storage,
        key,
        "session_save_handoff",
        replayedArgs,
        () => sessionSaveHandoffHandler(replayedArgs, undefined as any)
      );

      expect(result.isError).toBeFalsy();
    } finally {
      await storage.close();
    }
  }, 30_000);
});
