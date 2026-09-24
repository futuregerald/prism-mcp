#!/usr/bin/env node
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ShimSession, type ShimAction } from "./shim/session.js";
import { SHIM_MUTATING_TOOLS } from "./shim/mutatingTools.js";
import { makeLineSplitter, extractParseableId } from "./shim/lineSplitter.js";
import { getSocketPath, getSpawnMarkerPath, getLogPath, openDaemonLogFd } from "./shim/dataDir.js";
import { getPrismDataDir } from "./shim/dataDir.js";

const DEBUG = process.env.PRISM_SHIM_DEBUG === "1";

function debugLog(msg: string): void {
  if (DEBUG) {
    process.stderr.write(`[prism-connect] ${msg}\n`);
  }
}

let stdinPausedForSocket = false;

function pauseStdinForSocket(): void {
  if (!stdinPausedForSocket) {
    stdinPausedForSocket = true;
    process.stdin.pause();
  }
}

function resumeStdinIfPaused(): void {
  if (stdinPausedForSocket) {
    stdinPausedForSocket = false;
    process.stdin.resume();
  }
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
  debugLog(`writeToSocket ok=${ok} len=${line.length}`);
  if (!ok) {
    pauseStdinForSocket();
    socket.once("drain", resumeStdinIfPaused);
  }
}

const DAEMON_BOOT_GRACE_MS = 3000;
const SPAWN_CLAIM_TTL_MS = 10000;
const LOCK_PID_ALIVE_WAIT_MS = 30_000;

function readDaemonLock(dataDir: string): { pid: number; startedAt: number } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, "prismd.lock"), "utf8"));
    if (typeof parsed?.pid === "number" && typeof parsed?.startedAt === "number") return parsed;
  } catch { }
  return null;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function spawnClaimKey(dataDir: string, nowMs: number): string | null {
  const lock = readDaemonLock(dataDir);
  if (!lock) return "none";
  const ageMs = nowMs - lock.startedAt;
  if (isPidAlive(lock.pid)) {
    if (ageMs <= LOCK_PID_ALIVE_WAIT_MS) return null;
    return `${lock.pid}-${lock.startedAt}`;
  }
  if (ageMs < DAEMON_BOOT_GRACE_MS) return null;
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
    debugLog("skipping daemon spawn — a daemon is still booting or its pid is still alive");
    return;
  }
  if (!claimSpawn(spawnMarkerPath, key, nowMs)) {
    debugLog(`skipping daemon spawn — another shim already claimed respawn for ${key}`);
    return;
  }
  removeStaleSpawnClaims(spawnMarkerPath, nowMs);

  const daemonPath = process.env.PRISM_DAEMON_PATH
    || path.join(path.dirname(fileURLToPath(import.meta.url)), "daemon.js");
  const logFd = openDaemonLogFd(getLogPath());

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
    const onConnect = () => {
      socket.off("error", onError);
      resolve(socket);
    };
    const onError = (err: Error) => {
      socket.off("connect", onConnect);
      socket.destroy();
      reject(err);
    };
    socket.once("error", onError);
    socket.once("connect", onConnect);
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

    const onData = makeLineSplitter(
      line => {
        if (!line.trim()) return;
        dispatch(session.onDaemonLine(line));
      },
      () => {
        debugLog("daemon line exceeded max size — reconnecting");
        socket.destroy();
      }
    );
    socket.on("data", onData);

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      socket.off("data", onData);
      socket.off("close", finish);
      socket.off("error", finish);
      resumeStdinIfPaused();
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

  const onStdinLine = makeLineSplitter(
    line => {
      if (!line.trim()) return;
      const actions = session.onClientLine(line, Date.now());
      for (const action of actions) {
        if (action.to === "daemon" && currentSocket) {
          writeToSocket(currentSocket, action.line);
        } else if (action.to === "client") {
          writeToStdout(action.line, currentSocket);
        }
      }
    },
    discarded => {
      debugLog("client line exceeded max size — dropping");
      const id = extractParseableId(discarded.toString("utf8"));
      if (id !== null) {
        writeToStdout(JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32600, message: "request line too large" },
        }), currentSocket);
      }
    }
  );

  process.stdin.on("data", onStdinLine);
  process.stdin.on("end", () => {
    shuttingDown = true;
    debugLog("stdin closed — shutting down");
    const socket = currentSocket;
    if (!socket) {
      process.exit(0);
      return;
    }
    let exited = false;
    const doExit = () => {
      if (exited) return;
      exited = true;
      process.exit(0);
    };
    socket.once("close", doExit);
    const timer = setTimeout(doExit, 1000);
    timer.unref();
    socket.end();
  });

  let backoffMs = 50;
  while (!shuttingDown) {
    try {
      const socket = await connectSocket(socketPath);
      currentSocket = socket;
      resumeStdinIfPaused();
      const connectedAt = Date.now();
      debugLog("connected to daemon socket");
      await handleConnection(socket, session);
      currentSocket = null;
      if (Date.now() - connectedAt > 1000) {
        backoffMs = 50;
      }
      debugLog("disconnected from daemon socket");
    } catch (err) {
      currentSocket = null;
      const nodeErr = err as NodeJS.ErrnoException;
      if (isConnectFailure(nodeErr)) {
        maybeSpawnDaemon(dataDir);
      } else {
        debugLog(`connect error (retrying): ${nodeErr.code || nodeErr.message}`);
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
