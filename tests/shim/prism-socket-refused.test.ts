import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
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

describe("shim refuses an unsafe PRISM_SOCKET directory", () => {
  let shim: ChildProcess | undefined;

  afterEach(async () => {
    if (shim) await killProc(shim, "SIGKILL");
    shim = undefined;
  });

  it("answers pending requests with a JSON-RPC error and never spawns a daemon", async () => {
    const dataDir = freshDataDir();
    const unsafeDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-unsafe-socket-"));
    fs.chmodSync(unsafeDir, 0o777);
    const socketPath = path.join(unsafeDir, "prismd.sock");
    const noopDaemonPath = path.join(dataDir, "noop-daemon.js");
    fs.writeFileSync(noopDaemonPath, "");

    shim = spawn(process.execPath, [path.resolve("dist/shim.js")], {
      env: makeShimEnv(dataDir, dataDir, {
        PRISM_SOCKET: socketPath,
        PRISM_DAEMON_PATH: noopDaemonPath,
      }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = wrapNdjsonClient(shim);

    client.send(initializeRequest(1));
    const response = await client.waitFor(1, 5000);

    expect(response.error).toBeTruthy();
    expect(response.error.message).toMatch(/PRISM_SOCKET/);
    expect(fs.existsSync(socketPath)).toBe(false);

    fs.rmSync(unsafeDir, { recursive: true, force: true });
  });

  it("exits when stdin closes", async () => {
    const dataDir = freshDataDir();
    const unsafeDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-unsafe-socket-"));
    fs.chmodSync(unsafeDir, 0o777);
    const socketPath = path.join(unsafeDir, "prismd.sock");

    shim = spawn(process.execPath, [path.resolve("dist/shim.js")], {
      env: makeShimEnv(dataDir, dataDir, { PRISM_SOCKET: socketPath }),
      stdio: ["pipe", "pipe", "pipe"],
    });

    const exited = new Promise<number | null>(resolve => shim!.once("exit", code => resolve(code)));
    shim.stdin?.end();
    const code = await exited;
    expect(code).toBe(1);
    shim = undefined;

    fs.rmSync(unsafeDir, { recursive: true, force: true });
  });
});
