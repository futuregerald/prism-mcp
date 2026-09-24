import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";

import { ensureDaemonBuilt, spawnDaemon, killProc } from "./helpers.js";

describe("daemon refuses an unsafe PRISM_SOCKET directory", () => {
  let home: string;
  const spawned: ChildProcess[] = [];

  afterEach(async () => {
    await Promise.all(spawned.map(p => killProc(p)));
    spawned.length = 0;
  });

  it("exits non-zero and logs the reason to stderr, without binding a socket", async () => {
    ensureDaemonBuilt();
    home = fs.mkdtempSync(path.join(os.tmpdir(), "prd-"));
    const unsafeDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-unsafe-socket-"));
    fs.chmodSync(unsafeDir, 0o777);
    const socketPath = path.join(unsafeDir, "prismd.sock");

    const proc = spawnDaemon(home, home, { PRISM_SOCKET: socketPath });
    spawned.push(proc);

    let stderr = "";
    proc.stderr?.on("data", chunk => { stderr += chunk.toString("utf8"); });

    const exitCode = await new Promise<number | null>(resolve => proc.once("exit", code => resolve(code)));

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/PRISM_SOCKET/);
    expect(fs.existsSync(socketPath)).toBe(false);

    fs.rmSync(unsafeDir, { recursive: true, force: true });
  });
});
