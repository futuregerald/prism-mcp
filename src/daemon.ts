#!/usr/bin/env node
import * as net from "node:net";
import { getSocketPath, acquireDaemonLock } from "./daemon/instanceLock.js";

function requestShutdownOverSocket(socketPath: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection(socketPath);
    const onError = () => {
      resolve(false);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      socket.once("error", () => { });
      socket.write(JSON.stringify({ prism_admin: { v: 1, action: "shutdown" } }) + "\n");
      socket.end();
      resolve(true);
    });
  });
}

async function runRestart(): Promise<void> {
  const sent = await requestShutdownOverSocket(getSocketPath());
  if (!sent) {
    console.error("[prism-daemon] No daemon is running — nothing to restart");
    return;
  }
  console.error("[prism-daemon] Sent shutdown request to the running daemon over its socket");
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
      await runRestart();
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
