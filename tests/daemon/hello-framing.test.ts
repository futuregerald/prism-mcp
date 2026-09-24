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

describe("daemon hello framing (R1)", () => {
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

  it("answers hello + initialize + notifications/initialized + tools/list sent in ONE write()", async () => {
    const client = await connectRawClient(socketPath);
    try {
      const raw =
        helloLine("/tmp/project-a", "client-a") +
        JSON.stringify(initializeRequest(1)) + "\n" +
        JSON.stringify(initializedNotification()) + "\n" +
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n";

      client.write(raw);

      const initResponse = await client.waitFor(1, 15_000);
      expect(initResponse.result).toBeDefined();
      expect(initResponse.result.serverInfo).toBeDefined();

      const toolsResponse = await client.waitFor(2, 15_000);
      expect(toolsResponse.result).toBeDefined();
      expect(Array.isArray(toolsResponse.result.tools)).toBe(true);
      expect(toolsResponse.result.tools.length).toBeGreaterThan(0);
    } finally {
      client.close();
    }
  }, 20_000);

  it("exposes the socket at mode 0600", () => {
    const mode = fs.statSync(socketPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
