#!/usr/bin/env node
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ShimSession, type ShimAction } from "./shim/session.js";
import { SHIM_MUTATING_TOOLS } from "./shim/mutatingTools.js";
import { getSocketPath, getSpawnMarkerPath, getLogPath } from "./shim/dataDir.js";
import { getPrismDataDir } from "./shim/dataDir.js";

const DEBUG = process.env.PRISM_SHIM_DEBUG === "1";

function debugLog(msg: string): void {
  if (DEBUG) {
    process.stderr.write(`[prism-connect] ${msg}\n`);
  }
}

function makeLineSplitter(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let buffered = "";
  return (chunk: Buffer | string) => {
    buffered += chunk.toString("utf8");
    let idx: number;
    while ((idx = buffered.indexOf("\n")) !== -1) {
      let line = buffered.slice(0, idx);
      buffered = buffered.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      onLine(line);
    }
  };
}

function writeToStdout(line: string, throttleSource: net.Socket | null): void {
  const ok = process.stdout.write(line + "\n");
  if (!ok && throttleSource) {
    throttleSource.pause();
    process.stdout.once("drain", () => throttleSource.resume());
  }
}

function writeToSocket(socket: net.Socket, line: string): void {
  const ok = socket.write(line + "\n");
  if (!ok) {
    process.stdin.pause();
    socket.once("drain", () => process.stdin.resume());
  }
}

const DAEMON_BOOT_GRACE_MS = 3000;
const SPAWN_CLAIM_TTL_MS = 10000;

function readDaemonLock(dataDir: string): { pid: number; startedAt: number } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, "prismd.lock"), "utf8"));
    if (typeof parsed?.pid === "number" && typeof parsed?.startedAt === "number") return parsed;
  } catch { }
  return null;
}

function spawnClaimKey(dataDir: string, nowMs: number): string | null {
  const lock = readDaemonLock(dataDir);
  if (!lock) return "none";
  if (nowMs - lock.startedAt < DAEMON_BOOT_GRACE_MS) return null;
  return `${lock.pid}-${lock.startedAt}`;
}

function claimSpawn(spawnMarkerPath: string, key: string, nowMs: number): boolean {
  const claimPath = `${spawnMarkerPath}.${key}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.closeSync(fs.openSync(claimPath, "wx"));
      return true;
    } catch {
      try {
        if (nowMs - fs.statSync(claimPath).mtimeMs < SPAWN_CLAIM_TTL_MS) return false;
        fs.unlinkSync(claimPath);
      } catch {
        return false;
      }
    }
  }
  return false;
}

function removeStaleSpawnClaims(spawnMarkerPath: string, nowMs: number): void {
  const dir = path.dirname(spawnMarkerPath);
  const prefix = path.basename(spawnMarkerPath) + ".";
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const claimPath = path.join(dir, name);
    try {
      if (nowMs - fs.statSync(claimPath).mtimeMs > SPAWN_CLAIM_TTL_MS * 6) fs.unlinkSync(claimPath);
    } catch { }
  }
}

function maybeSpawnDaemon(dataDir: string): void {
  const spawnMarkerPath = getSpawnMarkerPath();
  const nowMs = Date.now();
  const key = spawnClaimKey(dataDir, nowMs);
  if (key === null) {
    debugLog("skipping daemon spawn — a daemon is still booting");
    return;
  }
  if (!claimSpawn(spawnMarkerPath, key, nowMs)) {
    debugLog(`skipping daemon spawn — another shim already claimed respawn for ${key}`);
    return;
  }
  removeStaleSpawnClaims(spawnMarkerPath, nowMs);

  const daemonPath = process.env.PRISM_DAEMON_PATH
    || path.join(path.dirname(fileURLToPath(import.meta.url)), "daemon.js");
  const logPath = getLogPath();
  const logFd = fs.openSync(logPath, "a");

  debugLog(`spawning daemon: ${daemonPath}`);
  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: dataDir,
    env: process.env,
  });
  child.unref();
  fs.closeSync(logFd);
}

function isConnectFailure(err: NodeJS.ErrnoException): boolean {
  return err.code === "ENOENT" || err.code === "ECONNREFUSED";
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function connectSocket(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const onError = (err: Error) => {
      socket.removeAllListeners();
      socket.destroy();
      reject(err);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      resolve(socket);
    });
  });
}

function handleConnection(socket: net.Socket, session: ShimSession): Promise<void> {
  return new Promise(resolve => {
    const dispatch = (actions: ShimAction[]) => {
      for (const action of actions) {
        if (action.to === "daemon") {
          writeToSocket(socket, action.line);
        } else {
          writeToStdout(action.line, socket);
        }
      }
    };

    dispatch(session.onConnected());

    const onData = makeLineSplitter(line => {
      if (!line.trim()) return;
      dispatch(session.onDaemonLine(line));
    });
    socket.on("data", onData);

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      session.onDisconnected(Date.now());
      resolve();
    };

    socket.once("close", finish);
    socket.once("error", finish);
  });
}

async function main(): Promise<void> {
  const dataDir = getPrismDataDir();
  const socketPath = getSocketPath();
  const clientId = crypto.randomUUID();
  const cwd = process.cwd();
  const requestTimeoutMs = parseInt(process.env.PRISM_SHIM_REQUEST_TIMEOUT_MS || "120000", 10);

  const session = new ShimSession({
    clientId,
    cwd,
    mutatingTools: SHIM_MUTATING_TOOLS,
    requestTimeoutMs,
  });

  let currentSocket: net.Socket | null = null;
  let shuttingDown = false;

  const timeoutInterval = setInterval(() => {
    const actions = session.checkTimeouts(Date.now());
    for (const action of actions) {
      writeToStdout(action.line, currentSocket);
    }
  }, 1000);
  timeoutInterval.unref();

  const onStdinLine = makeLineSplitter(line => {
    if (!line.trim()) return;
    const actions = session.onClientLine(line, Date.now());
    for (const action of actions) {
      if (action.to === "daemon" && currentSocket) {
        writeToSocket(currentSocket, action.line);
      } else if (action.to === "client") {
        writeToStdout(action.line, currentSocket);
      }
    }
  });

  process.stdin.on("data", onStdinLine);
  process.stdin.on("end", () => {
    shuttingDown = true;
    debugLog("stdin closed — shutting down");
    if (currentSocket) {
      currentSocket.end();
    }
    process.exit(0);
  });

  let backoffMs = 50;
  while (!shuttingDown) {
    try {
      const socket = await connectSocket(socketPath);
      currentSocket = socket;
      backoffMs = 50;
      debugLog("connected to daemon socket");
      await handleConnection(socket, session);
      currentSocket = null;
      debugLog("disconnected from daemon socket");
    } catch (err) {
      currentSocket = null;
      const nodeErr = err as NodeJS.ErrnoException;
      if (isConnectFailure(nodeErr)) {
        maybeSpawnDaemon(dataDir);
      }
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 250);
    }
  }
}

main().catch(err => {
  debugLog(`fatal error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  process.exit(1);
});
