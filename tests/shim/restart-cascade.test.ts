import { describe, it, expect, afterEach } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import {
  ensureShimBuilt,
  freshDataDir,
  spawnShim,
  makeShimEnv,
  wrapNdjsonClient,
  initializeRequest,
  initializedNotification,
  toolCallRequest,
  readLockPid,
  killProc,
  terminateAllDaemonsForCreatedDataDirs,
  waitFor,
  DAEMON_ENTRY,
  type NdjsonClient,
} from "./helpers.js";

ensureShimBuilt();

function runRestartCommand(dataDir: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DAEMON_ENTRY, "restart"], {
      env: makeShimEnv(dataDir, dataDir),
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", code => resolve(code));
  });
}

function realDaemonPidsForDataDir(dataDir: string): number[] {
  let listing = "";
  try {
    listing = execFileSync("ps", ["-E", "-ax", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return [];
  }
  const pids: number[] = [];
  for (const line of listing.split("\n")) {
    if (!line.includes(`PRISM_DATA_DIR=${dataDir}`)) continue;
    const tokens = line.trim().split(/\s+/);
    const pid = parseInt(tokens[0], 10);
    if (!Number.isFinite(pid) || pid === process.pid) continue;
    let isRealDaemonArgv = false;
    for (let i = 1; i < tokens.length; i++) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) break;
      if (tokens[i].endsWith("dist/daemon.js")) {
        isRealDaemonArgv = true;
        break;
      }
    }
    if (isRealDaemonArgv) pids.push(pid);
  }
  return pids;
}

describe("shim + daemon restart cascade", () => {
  const spawnedShims: ChildProcess[] = [];

  afterEach(async () => {
    for (const child of spawnedShims.splice(0)) {
      await killProc(child, "SIGTERM");
    }
    await terminateAllDaemonsForCreatedDataDirs();
  });

  it("`restart` followed by a client request produces exactly one successor daemon", async () => {
    const dataDir = freshDataDir();
    const child = spawnShim(dataDir, dataDir);
    spawnedShims.push(child);
    const client: NdjsonClient = wrapNdjsonClient(child);

    client.send(initializeRequest(1));
    const initResp = await client.waitFor(1, 20_000);
    expect(initResp.result).toBeDefined();
    client.send(initializedNotification());

    await waitFor(() => readLockPid(dataDir) !== null, 10_000, 100);
    const originalPid = readLockPid(dataDir);
    expect(originalPid).not.toBeNull();

    const restartExitCode = await runRestartCommand(dataDir);
    expect(restartExitCode).toBe(0);

    client.send(toolCallRequest(2, "session_load_context", { project: "restart-cascade-test", level: "quick" }));
    const response = await client.waitFor(2, 45_000);
    expect(response.error?.code).not.toBe(-32000);

    await waitFor(() => realDaemonPidsForDataDir(dataDir).length === 1, 20_000, 200);

    const livePids = realDaemonPidsForDataDir(dataDir);
    expect(livePids.length).toBe(1);
    expect(livePids[0]).not.toBe(originalPid);
  }, 60_000);
});
