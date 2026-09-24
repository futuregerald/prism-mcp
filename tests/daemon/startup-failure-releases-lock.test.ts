import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";

import { ensureDaemonBuilt, spawnDaemon, killProc, getSocketPath } from "./helpers.js";

describe("daemon releases its lock when it fails to start", () => {
  let home: string;
  const spawned: ChildProcess[] = [];

  afterEach(async () => {
    await Promise.all(spawned.map(p => killProc(p)));
    spawned.length = 0;
  });

  it("removes the lock file it just wrote when server.listen fails, instead of exiting with a stale lock", async () => {
    ensureDaemonBuilt();
    home = fs.mkdtempSync(path.join(os.tmpdir(), "prd-"));
    const socketPath = getSocketPath(home);
    fs.writeFileSync(socketPath, "not a socket, occupies the path");

    const proc = spawnDaemon(home, home);
    spawned.push(proc);

    let stderr = "";
    proc.stderr?.on("data", chunk => { stderr += chunk.toString("utf8"); });

    const exitCode = await new Promise<number | null>(resolve => proc.once("exit", code => resolve(code)));

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/Fatal error/);

    const lockPath = path.join(home, "prismd.lock");
    expect(fs.existsSync(lockPath)).toBe(false);
  }, 30_000);
});
