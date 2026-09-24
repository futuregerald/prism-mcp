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

describe("daemon caps the length of a single incoming line", () => {
  let proc: ChildProcess;
  let socketPath: string;

  beforeAll(async () => {
    ensureDaemonBuilt();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "prd-line-"));
    proc = spawnDaemon(home, home, { PRISM_DAEMON_MAX_LINE_BYTES: "65536" });
    socketPath = getSocketPath(home);
    await waitForSocket(socketPath, 15_000);
  }, 30_000);

  afterAll(async () => {
    if (proc) await killProc(proc);
  });

  it("closes a connection that sends a line longer than the cap, and keeps serving others", async () => {
    const flooder = await connectRawClient(socketPath);
    flooder.write(helloLine("/tmp/line-cap", "flooder"));
    flooder.send(initializeRequest(1));
    await flooder.waitFor(1, 15_000);

    const closed = new Promise<void>(resolve => flooder.socket.once("close", () => resolve()));
    const chunk = "x".repeat(16 * 1024);
    for (let i = 0; i < 8; i++) flooder.write(chunk);
    await closed;

    const healthy = await connectRawClient(socketPath);
    healthy.write(helloLine("/tmp/line-cap", "healthy"));
    healthy.send(initializeRequest(2));
    const init = await healthy.waitFor(2, 15_000);
    healthy.send(initializedNotification());
    expect(init.result).toBeDefined();
    healthy.close();
  }, 30_000);

  it("does not close a connection whose lines each stay under the cap", async () => {
    const client = await connectRawClient(socketPath);
    client.write(helloLine("/tmp/line-cap", "normal"));
    client.send(initializeRequest(3));
    await client.waitFor(3, 15_000);
    client.send(initializedNotification());

    let closedEarly = false;
    client.socket.once("close", () => { closedEarly = true; });
    for (let i = 0; i < 8; i++) {
      client.send({ jsonrpc: "2.0", id: 100 + i, method: "tools/list", params: { _pad: "y".repeat(30 * 1024) } });
      await client.waitFor(100 + i, 15_000);
    }
    expect(closedEarly).toBe(false);
    client.close();
  }, 60_000);
});
