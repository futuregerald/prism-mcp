import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acquireDaemonLock } from "../../src/daemon/instanceLock.js";

describe("acquireDaemonLock — pid-alive takeover", () => {
  const spawned: ChildProcess[] = [];
  const originalDataDir = process.env.PRISM_DATA_DIR;
  const originalSocket = process.env.PRISM_SOCKET;

  afterEach(() => {
    for (const child of spawned.splice(0)) {
      try { child.kill("SIGKILL"); } catch { }
    }
    if (originalDataDir === undefined) delete process.env.PRISM_DATA_DIR;
    else process.env.PRISM_DATA_DIR = originalDataDir;
    if (originalSocket === undefined) delete process.env.PRISM_SOCKET;
    else process.env.PRISM_SOCKET = originalSocket;
  });

  it("waits for a live lock pid to exit before breaking an old lock, instead of taking over immediately", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prd-"));
    process.env.PRISM_DATA_DIR = dir;
    delete process.env.PRISM_SOCKET;

    const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 400)"], { stdio: "ignore" });
    spawned.push(child);
    await new Promise<void>(resolve => child.once("spawn", () => resolve()));

    const lockPath = path.join(dir, "prismd.lock");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: child.pid, startedAt: Date.now() - 10_000 }));

    const start = Date.now();
    const result = await acquireDaemonLock();
    const elapsedMs = Date.now() - start;

    expect(result.alreadyRunning).toBe(false);
    expect(elapsedMs).toBeGreaterThan(350);
    expect(elapsedMs).toBeLessThan(3000);

    const confirmed = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    expect(confirmed.pid).toBe(process.pid);
  }, 20_000);
});
