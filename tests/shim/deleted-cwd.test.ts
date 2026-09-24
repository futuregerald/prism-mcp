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
  initializedNotification,
  killProc,
  terminateAllDaemonsForCreatedDataDirs,
  SHIM_ENTRY,
} from "./helpers.js";

ensureShimBuilt();

const spawned: ChildProcess[] = [];

afterEach(async () => {
  for (const child of spawned) await killProc(child, "SIGTERM");
  spawned.length = 0;
  await terminateAllDaemonsForCreatedDataDirs();
});

const unixOnly = process.platform === "win32" ? it.skip : it;

describe("shim started from a working directory that no longer exists", () => {
  unixOnly("still connects and answers initialize and tools/list", async () => {
    const dataDir = freshDataDir();
    const gone = fs.mkdtempSync(path.join(os.tmpdir(), "prs-gone-"));
    const child = spawn(
      "/bin/sh",
      ["-c", 'cd "$1" && rmdir "$1" && exec "$2" "$3"', "sh", gone, process.execPath, SHIM_ENTRY],
      { env: makeShimEnv(dataDir, dataDir), stdio: ["pipe", "pipe", "pipe"] }
    );
    spawned.push(child);
    const client = wrapNdjsonClient(child);

    client.send(initializeRequest(1));
    const init = await client.waitFor(1, 30_000);
    expect(init.result).toBeDefined();
    client.send(initializedNotification());
    client.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const tools = await client.waitFor(2, 30_000);
    expect(tools.result.tools.length).toBeGreaterThan(20);
    expect(fs.existsSync(gone)).toBe(false);
  }, 60_000);

  unixOnly("the in-process stdio server (PRISM_SHARED_DAEMON=false) also starts and answers", async () => {
    const dataDir = freshDataDir();
    const gone = fs.mkdtempSync(path.join(os.tmpdir(), "prs-gone-"));
    const legacyEntry = path.join(path.dirname(SHIM_ENTRY), "server.js");
    const child = spawn(
      "/bin/sh",
      ["-c", 'cd "$1" && rmdir "$1" && exec "$2" "$3"', "sh", gone, process.execPath, legacyEntry],
      { env: makeShimEnv(dataDir, dataDir, { PRISM_SHARED_DAEMON: "false" }), stdio: ["pipe", "pipe", "pipe"] }
    );
    spawned.push(child);
    const client = wrapNdjsonClient(child);

    client.send(initializeRequest(1));
    const init = await client.waitFor(1, 30_000);
    expect(init.result).toBeDefined();
    client.send(initializedNotification());
    client.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const tools = await client.waitFor(2, 30_000);
    expect(tools.result.tools.length).toBeGreaterThan(20);
    expect(fs.existsSync(path.join(dataDir, "prismd.lock"))).toBe(false);
  }, 60_000);
});
