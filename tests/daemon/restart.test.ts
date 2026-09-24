import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ensureDaemonBuilt,
  getDaemonEntry,
  spawnDaemon,
  makeDaemonEnv,
  waitForSocket,
  killProc,
  getSocketPath,
} from "./helpers.js";

function runRestartCommand(home: string, dataDir: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [getDaemonEntry(), "restart"], {
      env: makeDaemonEnv(home, dataDir),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", chunk => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", code => resolve({ code, stderr }));
  });
}

describe("prism-daemon restart (R-admin)", () => {
  let proc: ChildProcess | undefined;

  afterEach(async () => {
    if (proc) await killProc(proc);
    proc = undefined;
  });

  it("sends an admin shutdown over the socket and the daemon exits gracefully, without ever reading or signalling a pid", async () => {
    ensureDaemonBuilt();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "prd-"));
    const dataDir = home;

    proc = spawnDaemon(home, dataDir);
    const socketPath = getSocketPath(dataDir);
    await waitForSocket(socketPath, 15_000);

    const restartResult = await runRestartCommand(home, dataDir);
    expect(restartResult.code).toBe(0);

    await new Promise<void>(resolve => {
      if (proc!.exitCode !== null || proc!.signalCode !== null) { resolve(); return; }
      proc!.once("exit", () => resolve());
    });

    expect(proc!.signalCode).toBeNull();
    expect(proc!.exitCode).toBe(0);
  }, 20_000);

  it("prints that no daemon is running and exits 0 when nothing is listening", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prd-"));

    const restartResult = await runRestartCommand(dataDir, dataDir);
    expect(restartResult.code).toBe(0);
    expect(restartResult.stderr).toContain("No daemon is running");
  }, 10_000);
});
