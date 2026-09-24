import { describe, it, expect, afterEach } from "vitest";
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

describe("daemon graceful shutdown (R6)", () => {
  let proc: ChildProcess | undefined;

  afterEach(async () => {
    if (proc) await killProc(proc);
    proc = undefined;
  });

  it("finishes an in-flight save and persists it before exiting on SIGTERM", async () => {
    ensureDaemonBuilt();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "prd-"));
    const dataDir = home;

    proc = spawnDaemon(home, dataDir, { PRISM_TEST_SAVE_DELAY_MS: "1500" });
    const socketPath = getSocketPath(dataDir);
    await waitForSocket(socketPath, 15_000);

    const client = await connectRawClient(socketPath);
    client.write(helloLine("/tmp/shutdown-test", "shutdown-client"));
    client.send(initializeRequest(1));
    await client.waitFor(1, 15_000);
    client.send(initializedNotification());

    client.send({
      jsonrpc: "2.0",
      id: 50,
      method: "tools/call",
      params: {
        name: "session_save_ledger",
        arguments: { project: "shutdown-test", conversation_id: "conv-shutdown", summary: "Slowed save in flight" },
      },
    });

    await new Promise(resolve => setTimeout(resolve, 300));
    proc.kill("SIGTERM");

    const response = await client.waitFor(50, 15_000);
    expect(response.result).toBeDefined();

    await new Promise<void>(resolve => {
      if (proc!.exitCode !== null) { resolve(); return; }
      proc!.once("exit", () => resolve());
    });

    const storage = new SqliteStorage();
    await storage.initialize(path.join(dataDir, "data.db"));
    try {
      const entries = await storage.getLedgerEntries({
        project: "eq.shutdown-test",
        conversation_id: "eq.conv-shutdown",
      } as any);
      expect(entries.length).toBe(1);
    } finally {
      await storage.close();
    }
  }, 30_000);
});
