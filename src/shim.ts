#!/usr/bin/env node
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ShimSession, type ShimAction } from "./shim/session.js";
import { MUTATING_TOOLS } from "./tools/mutatingTools.js";
import { makeLineSplitter, extractParseableId } from "./shim/lineSplitter.js";
import { getSocketPath, getSpawnMarkerPath, getLogPath, openDaemonLogFd } from "./shim/dataDir.js";
import { getPrismDataDir } from "./shim/dataDir.js";
import { readLock, isPidAlive, LOCK_PID_ALIVE_WAIT_MS } from "./daemon/instanceLock.js";
import { checkExplicitSocketPath, isOwnedByCurrentUser } from "./utils/dataDir.js";
import { computeConfigFingerprint } from "./utils/configFingerprint.js";
import { parsePositiveIntEnv } from "./utils/envInt.js";

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

let stdoutDrainListenerPending: net.Socket | null = null;

function writeToStdout(line: string, throttleSource: net.Socket | null): void {
  const ok = process.stdout.write(line + "\n");
  if (!ok && throttleSource) {
    throttleSource.pause();
    if (!stdoutDrainListenerPending) {
      stdoutDrainListenerPending = throttleSource;
      process.stdout.once("drain", () => {
        const source = stdoutDrainListenerPending;
        stdoutDrainListenerPending = null;
        source?.resume();
      });
    }
  }
}

let socketDrainListenerPending = false;

function resetSocketDrainListenerState(): void {
  socketDrainListenerPending = false;
}

function writeToSocket(socket: net.Socket, line: string): void {
  const ok = socket.write(line + "\n");
  debugLog(`writeToSocket ok=${ok} len=${line.length}`);
  if (!ok) {
    pauseStdinForSocket();
    if (!socketDrainListenerPending) {
      socketDrainListenerPending = true;
      socket.once("drain", () => {
        socketDrainListenerPending = false;
        resumeStdinIfPaused();
      });
    }
  }
}

function tryParseJson(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function extractRequestId(line: string): unknown {
  const parsed = tryParseJson(line);
  if (
    parsed
    && typeof parsed === "object"
    && Object.prototype.hasOwnProperty.call(parsed, "id")
    && parsed.id !== undefined
    && typeof parsed.method === "string"
  ) {
    return parsed.id;
  }
  return undefined;
}

function runSocketRefusedMode(reason: string): void {
  debugLog(`refusing PRISM_SOCKET: ${reason}`);
  const message = `prism daemon refused: PRISM_SOCKET is unsafe — ${reason}`;

  const onStdinLine = makeLineSplitter(
    line => {
      if (!line.trim()) return;
      const id = extractRequestId(line);
      if (id === undefined) return;
      writeToStdout(JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32010, message },
      }), null);
    },
    () => { }
  );

  process.stdin.on("data", onStdinLine);
  process.stdin.on("end", () => process.exit(1));
}

const DAEMON_BOOT_GRACE_MS = 3000;
const SPAWN_CLAIM_TTL_MS = 10000;

function readDaemonLock(dataDir: string): { pid: number; startedAt: number } | null {
  return readLock(path.join(dataDir, "prismd.lock"));
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

function maybeSpawnDaemon(dataDir: string, onStartupFailure: () => void): boolean {
  const spawnMarkerPath = getSpawnMarkerPath();
  const nowMs = Date.now();
  const key = spawnClaimKey(dataDir, nowMs);
  if (key === null) {
    debugLog("skipping daemon spawn — a daemon is still booting or its pid is still alive");
    return false;
  }
  if (!claimSpawn(spawnMarkerPath, key, nowMs)) {
    debugLog(`skipping daemon spawn — another shim already claimed respawn for ${key}`);
    return false;
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
  const claimPath = `${spawnMarkerPath}.${key}`;
  child.once("exit", (code, signal) => {
    try { fs.unlinkSync(claimPath); } catch { }
    if (signal === null && code !== 0) onStartupFailure();
  });
  child.unref();
  fs.closeSync(logFd);
  return true;
}

function isConnectFailure(err: NodeJS.ErrnoException): boolean {
  return err.code === "ENOENT" || err.code === "ECONNREFUSED";
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function socketOwnershipProblem(socketPath: string): string | null {
  const st = fs.lstatSync(socketPath, { throwIfNoEntry: false });
  if (!st) return null;
  if (!st.isSocket()) return `${socketPath} is not a socket`;
  if (!isOwnedByCurrentUser(st.uid)) return `${socketPath} is not owned by the current user`;
  return null;
}

function connectSocket(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const problem = socketOwnershipProblem(socketPath);
    if (problem) {
      reject(Object.assign(new Error(`refusing to connect: ${problem}`), { code: "EUNSAFESOCKET" }));
      return;
    }
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
  resetSocketDrainListenerState();
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
      discarded => {
        debugLog("daemon line exceeded max size — reconnecting");
        const id = extractParseableId(discarded.toString("utf8"));
        if (id !== null) {
          dispatch(session.failInFlightRequest(id, -32004, "prism daemon response exceeded the maximum line size for this request; not retried"));
        }
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
  if (process.env.PRISM_SOCKET) {
    const check = checkExplicitSocketPath(process.env.PRISM_SOCKET);
    if (!check.ok) {
      runSocketRefusedMode(check.reason ?? "PRISM_SOCKET directory is not safe");
      return;
    }
  }

  const dataDir = getPrismDataDir();
  const socketPath = getSocketPath();
  const clientId = crypto.randomUUID();
  const cwd = process.cwd();
  const requestTimeoutMs = parsePositiveIntEnv(process.env.PRISM_SHIM_REQUEST_TIMEOUT_MS, 120000);

  const session = new ShimSession({
    clientId,
    cwd,
    mutatingTools: MUTATING_TOOLS,
    requestTimeoutMs,
    configFingerprint: computeConfigFingerprint(),
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

  const SPAWN_BACKOFF_INITIAL_MS = 1000;
  const SPAWN_BACKOFF_CAP_MS = 30_000;
  const STARTUP_FAILURE_THRESHOLD = 3;

  let backoffMs = 50;
  let spawnBackoffMs = SPAWN_BACKOFF_INITIAL_MS;
  let nextSpawnAttemptAt = 0;
  let consecutiveFailedSpawns = 0;
  const recordStartupFailure = () => { consecutiveFailedSpawns += 1; };

  while (!shuttingDown && !session.isFatal()) {
    try {
      const socket = await connectSocket(socketPath);
      currentSocket = socket;
      resumeStdinIfPaused();
      spawnBackoffMs = SPAWN_BACKOFF_INITIAL_MS;
      nextSpawnAttemptAt = 0;
      consecutiveFailedSpawns = 0;
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
        const now = Date.now();
        if (now >= nextSpawnAttemptAt) {
          const attempted = maybeSpawnDaemon(dataDir, recordStartupFailure);
          if (attempted) {
            nextSpawnAttemptAt = now + spawnBackoffMs;
            spawnBackoffMs = Math.min(spawnBackoffMs * 2, SPAWN_BACKOFF_CAP_MS);
          }
        }
        if (consecutiveFailedSpawns >= STARTUP_FAILURE_THRESHOLD) {
          const message = `prism daemon failed to start; see ${getLogPath()}`;
          const failures = session.failAllPendingWithError(-32003, message);
          if (failures.length > 0) {
            debugLog(`${consecutiveFailedSpawns} consecutive daemon starts exited with an error — ${message}`);
          }
          for (const action of failures) {
            writeToStdout(action.line, currentSocket);
          }
        }
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
