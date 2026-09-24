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
  type RawJsonRpcClient,
} from "./helpers.js";

async function initClient(socketPath: string, cwd: string, clientId: string): Promise<RawJsonRpcClient> {
  const client = await connectRawClient(socketPath);
  client.write(helloLine(cwd, clientId));
  client.send(initializeRequest(1));
  await client.waitFor(1, 15_000);
  client.send(initializedNotification());
  return client;
}

describe("daemon concurrent clients (R3)", () => {
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

  it("serves two clients concurrently, each seeing its own saved summary, with real resources/list", async () => {
    const clientA = await initClient(socketPath, "/tmp/project-a", "client-a");
    const clientB = await initClient(socketPath, "/tmp/project-b", "client-b");

    try {
      // session_load_context and resources/list are both backed by
      // session_handoffs (not session_ledger — session_save_ledger's
      // embedding kick-off also needs an LLM provider, which this sandbox
      // has none configured for), so use session_save_handoff here.
      clientA.send({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "session_save_handoff",
          arguments: { project: "daemon-test-a", last_summary: "Client A did work" },
        },
      });
      clientB.send({
        jsonrpc: "2.0",
        id: 20,
        method: "tools/call",
        params: {
          name: "session_save_handoff",
          arguments: { project: "daemon-test-b", last_summary: "Client B did work" },
        },
      });

      const [saveA, saveB] = await Promise.all([clientA.waitFor(10, 15_000), clientB.waitFor(20, 15_000)]);
      expect(saveA.result.isError).toBeFalsy();
      expect(saveB.result.isError).toBeFalsy();

      clientA.send({
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name: "session_load_context", arguments: { project: "daemon-test-a", level: "standard" } },
      });
      clientB.send({
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: { name: "session_load_context", arguments: { project: "daemon-test-b", level: "standard" } },
      });

      const [loadA, loadB] = await Promise.all([clientA.waitFor(11, 15_000), clientB.waitFor(21, 15_000)]);
      const textA = loadA.result.content.map((c: any) => c.text).join("\n");
      const textB = loadB.result.content.map((c: any) => c.text).join("\n");
      expect(textA).toContain("Client A did work");
      expect(textB).toContain("Client B did work");
      expect(textA).not.toContain("Client B did work");
      expect(textB).not.toContain("Client A did work");

      clientA.send({ jsonrpc: "2.0", id: 12, method: "resources/list", params: {} });
      const resourcesResponse = await clientA.waitFor(12, 15_000);
      expect(resourcesResponse.result).toBeDefined();
      const uris = resourcesResponse.result.resources.map((r: any) => r.uri);
      expect(uris).toContain("memory://daemon-test-a/handoff");
      expect(uris).toContain("memory://daemon-test-b/handoff");
    } finally {
      clientA.close();
      clientB.close();
    }
  }, 30_000);
});
