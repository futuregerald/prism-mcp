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

describe("daemon idempotent retries (M3 + prism_request_log)", () => {
  let home: string;
  let dataDir: string;
  let proc: ChildProcess;
  let socketPath: string;

  beforeAll(async () => {
    ensureDaemonBuilt();
    home = fs.mkdtempSync(path.join(os.tmpdir(), "prd-"));
    dataDir = home;
    proc = spawnDaemon(home, dataDir);
    socketPath = getSocketPath(dataDir);
    await waitForSocket(socketPath);
  }, 30_000);

  afterAll(async () => {
    await killProc(proc);
  });

  it("returns the identical response for a repeated idempotency key, with the handler run exactly once", async () => {
    const client = await connectRawClient(socketPath);
    const idempotencyKey = "test-client:call-42";

    try {
      client.write(helloLine("/tmp/idempotency-project", "idem-client"));
      client.send(initializeRequest(1));
      await client.waitFor(1, 15_000);
      client.send(initializedNotification());

      const callArgs = {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "session_save_handoff",
          arguments: { project: "idempotency-test", last_summary: "Idempotent handoff save" },
          _meta: { "prism/idempotencyKey": idempotencyKey },
        },
      };

      client.send({ ...callArgs, id: 100 });
      const first = await client.waitFor(100, 15_000);
      expect(first.result.isError).toBeFalsy();

      client.send({ ...callArgs, id: 101 });
      const second = await client.waitFor(101, 15_000);

      expect(second.result).toEqual(first.result);
    } finally {
      client.close();
    }

    const storage = new SqliteStorage();
    await storage.initialize(path.join(dataDir, "data.db"));
    try {
      const context = await storage.loadContext("idempotency-test", "quick", "default");
      expect((context as any)?.version).toBe(1);
    } finally {
      await storage.close();
    }
  }, 30_000);
});
