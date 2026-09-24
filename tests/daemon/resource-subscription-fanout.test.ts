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

describe("resource subscription fan-out targets the subscribing connection (B4)", () => {
  let proc: ChildProcess | undefined;

  afterEach(async () => {
    if (proc) await killProc(proc);
    proc = undefined;
  });

  it("client A subscribes, client B saves a handoff for the same project — A (not B) gets notified; closing B mid-save does not crash the daemon", async () => {
    ensureDaemonBuilt();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "prd-b4-"));
    const dataDir = home;
    proc = spawnDaemon(home, dataDir);
    const socketPath = getSocketPath(dataDir);
    await waitForSocket(socketPath, 15_000);

    const project = "b4-fanout";
    const uri = `memory://${project}/handoff`;

    const clientA = await connectRawClient(socketPath);
    clientA.write(helloLine("/tmp/b4-a", "b4-client-a"));
    clientA.send(initializeRequest(1));
    await clientA.waitFor(1, 15_000);
    clientA.send(initializedNotification());

    clientA.send({ jsonrpc: "2.0", id: 10, method: "resources/subscribe", params: { uri } });
    const subAck = await clientA.waitFor(10, 15_000);
    expect(subAck.result).toBeDefined();

    const clientB = await connectRawClient(socketPath);
    clientB.write(helloLine("/tmp/b4-b", "b4-client-b"));
    clientB.send(initializeRequest(1));
    await clientB.waitFor(1, 15_000);
    clientB.send(initializedNotification());

    clientB.send({
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: {
        name: "session_save_handoff",
        arguments: { project, last_summary: "Triggering a fan-out notification" },
      },
    });
    const saveResponse = await clientB.waitFor(20, 15_000);
    expect(saveResponse.result.isError).toBeFalsy();

    clientB.close();

    const deadline = Date.now() + 5000;
    let received = false;
    while (Date.now() < deadline) {
      if (clientA.notifications.some((n: any) => n.method === "notifications/resources/updated" && n.params?.uri === uri)) {
        received = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(received).toBe(true);
    expect(clientB.notifications.some((n: any) => n.method === "notifications/resources/updated")).toBe(false);

    const clientC = await connectRawClient(socketPath);
    clientC.write(helloLine("/tmp/b4-c", "b4-client-c"));
    clientC.send(initializeRequest(1));
    const initC = await clientC.waitFor(1, 15_000);
    expect(initC.result).toBeDefined();

    clientA.close();
    clientC.close();
  }, 30_000);
});
