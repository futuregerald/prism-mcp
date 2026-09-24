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

describe("daemon rejects new tool calls once shutdown begins (B9)", () => {
  let proc: ChildProcess | undefined;

  afterEach(async () => {
    if (proc) await killProc(proc);
    proc = undefined;
  });

  it("a tools/call sent after SIGTERM but before exit returns an isError result, not a hang", async () => {
    ensureDaemonBuilt();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "prd-b9-"));
    const dataDir = home;

    proc = spawnDaemon(home, dataDir, { PRISM_TEST_SAVE_DELAY_MS: "1500" });
    const socketPath = getSocketPath(dataDir);
    await waitForSocket(socketPath, 15_000);

    const blockerClient = await connectRawClient(socketPath);
    blockerClient.write(helloLine("/tmp/b9-project", "b9-blocker"));
    blockerClient.send(initializeRequest(1));
    await blockerClient.waitFor(1, 15_000);
    blockerClient.send(initializedNotification());

    const lateClient = await connectRawClient(socketPath);
    lateClient.write(helloLine("/tmp/b9-project", "b9-late"));
    lateClient.send(initializeRequest(2));
    await lateClient.waitFor(2, 15_000);
    lateClient.send(initializedNotification());

    blockerClient.send({
      jsonrpc: "2.0",
      id: 50,
      method: "tools/call",
      params: {
        name: "session_save_ledger",
        arguments: { project: "b9-shutdown", conversation_id: "conv-b9", summary: "in-flight during shutdown" },
      },
    });
    await new Promise(resolve => setTimeout(resolve, 200));

    proc.kill("SIGTERM");
    await new Promise(resolve => setTimeout(resolve, 100));

    lateClient.send({
      jsonrpc: "2.0",
      id: 51,
      method: "tools/call",
      params: {
        name: "session_save_ledger",
        arguments: { project: "b9-shutdown", conversation_id: "conv-b9-late", summary: "should be rejected" },
      },
    });

    const lateResponse = await lateClient.waitFor(51, 15_000);
    expect(lateResponse.result.isError).toBe(true);
    expect(lateResponse.result.content[0].text).toContain("shutting down");

    const inFlightResponse = await blockerClient.waitFor(50, 15_000);
    expect(inFlightResponse.result.isError).toBeFalsy();

    blockerClient.close();
    lateClient.close();
  }, 30_000);
});
