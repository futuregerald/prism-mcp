#!/usr/bin/env node
import * as fs from "node:fs";
import { getLockPath } from "./daemon/instanceLock.js";
import { acquireDaemonLock } from "./daemon/instanceLock.js";

function readLockPid(): number | null {
  try {
    const raw = fs.readFileSync(getLockPath(), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.pid === "number" ? parsed.pid : null;
  } catch {
    return null;
  }
}

function runRestart(): void {
  const pid = readLockPid();
  if (!pid) {
    console.error("[prism-daemon] No lock file found — nothing to restart");
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    console.error(`[prism-daemon] Sent SIGTERM to daemon pid ${pid}`);
  } catch (err) {
    console.error(`[prism-daemon] Failed to signal pid ${pid}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function runPruneZeroSdm(): Promise<void> {
  const { getStorage } = await import("./storage/index.js");
  const storage = await getStorage();
  const result = await storage.pruneZeroSdmState();
  console.error(`[prism-daemon] prune-zero-sdm: pruned ${result.pruned.length} project(s): ${JSON.stringify(result.pruned)}`);
}

async function runDaemon(): Promise<void> {
  const lock = await acquireDaemonLock();
  if (lock.alreadyRunning) {
    console.error("[prism-daemon] Another daemon is already running on this data dir — exiting");
    process.exit(0);
    return;
  }

  process.env.PRISM_ACTR_WRITE_THROUGH = "true";

  const { runDaemonMain } = await import("./daemon/main.js");
  await runDaemonMain(lock.paths);
}

async function main(): Promise<void> {
  const subcommand = process.argv[2];
  switch (subcommand) {
    case "restart":
      runRestart();
      process.exit(0);
      return;
    case "prune-zero-sdm":
      await runPruneZeroSdm();
      process.exit(0);
      return;
    default:
      await runDaemon();
  }
}

main().catch(err => {
  console.error(`[prism-daemon] Fatal error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  process.exit(1);
});
