import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
} from "./helpers.js";

describe("daemon single-instance locking (R7)", () => {
  let home: string;
  let dataDir: string;
  const spawned: ChildProcess[] = [];

  beforeEach(() => {
    ensureDaemonBuilt();
    home = fs.mkdtempSync(path.join(os.tmpdir(), "prd-"));
    dataDir = home;
  });

  afterEach(async () => {
    await Promise.all(spawned.map(p => killProc(p)));
    spawned.length = 0;
  });

  it("only one daemon stays running when two are started concurrently on the same data dir, and both socket clients work", async () => {
    const procA = spawnDaemon(home, dataDir);
    const procB = spawnDaemon(home, dataDir);
    spawned.push(procA, procB);

    const socketPath = getSocketPath(dataDir);
    await waitForSocket(socketPath, 15_000);

    const loserDeadline = Date.now() + 15_000;
    while ([procA.exitCode, procB.exitCode].every(code => code === null) && Date.now() < loserDeadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await new Promise(resolve => setTimeout(resolve, 500));

    const exitedCodes = [procA.exitCode, procB.exitCode];
    const exitedCount = exitedCodes.filter(code => code !== null).length;
    const runningCount = exitedCodes.filter(code => code === null).length;

    expect(exitedCount).toBe(1);
    expect(runningCount).toBe(1);
    for (const code of exitedCodes) {
      if (code !== null) expect(code).toBe(0);
    }

    for (const clientId of ["client-1", "client-2"]) {
      const client = await connectRawClient(socketPath);
      try {
        client.write(helloLine("/tmp/single-instance", clientId));
        client.send(initializeRequest(1));
        const response = await client.waitFor(1, 15_000);
        expect(response.result).toBeDefined();
      } finally {
        client.close();
      }
    }
  }, 45_000);

  it("breaks a stale lock (foreign/dead pid, startedAt older than 3s) and starts normally", async () => {
    const lockPath = path.join(dataDir, "prismd.lock");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 1, startedAt: Date.now() - 10_000 }));

    const proc = spawnDaemon(home, dataDir);
    spawned.push(proc);

    const socketPath = getSocketPath(dataDir);
    await waitForSocket(socketPath, 15_000);

    const lockContents = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    expect(lockContents.pid).toBe(proc.pid);
  }, 20_000);
});
