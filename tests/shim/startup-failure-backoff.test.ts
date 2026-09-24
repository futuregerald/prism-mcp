import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import {
  ensureShimBuilt,
  freshDataDir,
  makeShimEnv,
  wrapNdjsonClient,
  initializeRequest,
  killProc,
} from "./helpers.js";

ensureShimBuilt();

describe("shim reports a startup-failure error when the daemon keeps failing to start", () => {
  let shim: ChildProcess | undefined;

  afterEach(async () => {
    if (shim) await killProc(shim, "SIGKILL");
    shim = undefined;
  });

  it("answers a pending request with -32003 within ~10s when PRISM_DAEMON_PATH always exits 1", async () => {
    const dataDir = freshDataDir();
    const failingDaemonPath = path.join(dataDir, "failing-daemon.js");
    fs.writeFileSync(failingDaemonPath, "process.exit(1);\n");

    shim = spawn(process.execPath, [path.resolve("dist/shim.js")], {
      env: makeShimEnv(dataDir, dataDir, { PRISM_DAEMON_PATH: failingDaemonPath }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = wrapNdjsonClient(shim);

    client.send(initializeRequest(1));
    const response = await client.waitFor(1, 10_000);

    expect(response.error).toBeTruthy();
    expect(response.error.code).toBe(-32003);
    expect(response.error.message).toMatch(/prism daemon failed to start/);
    expect(response.error.message).toContain(path.join(dataDir, "prismd.log"));
  }, 15_000);
});
