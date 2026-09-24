/**
 * Single-instance locking for the shared daemon (builtins-only — no SDK,
 * no server.ts, nothing that would slow down the daemon.js bootstrap).
 *
 * The Unix socket is the source of truth (R7): a reused PID can never wedge
 * the lock, because staleness is decided by whether the socket accepts a
 * connection, not by `kill(pid, 0)`.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { getPrismDataDir } from "../utils/dataDir.js";

export interface LockPaths {
  socketPath: string;
  lockPath: string;
}

export interface LockResult {
  alreadyRunning: boolean;
  paths: LockPaths;
}

interface LockFileContents {
  pid: number;
  startedAt: number;
}

export function getSocketPath(): string {
  return process.env.PRISM_SOCKET || path.join(getPrismDataDir(), "prismd.sock");
}

export function getLockPath(): string {
  return path.join(getPrismDataDir(), "prismd.lock");
}

function probeSocket(socketPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function readLock(lockPath: string): LockFileContents | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.pid === "number" && typeof parsed?.startedAt === "number") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function writeLockExclusive(lockPath: string, contents: LockFileContents): boolean {
  try {
    fs.writeFileSync(lockPath, JSON.stringify(contents), { flag: "wx" });
    return true;
  } catch (err) {
    if (err && (err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

async function waitForSocket(socketPath: string, maxWaitMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await probeSocket(socketPath, 200)) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

async function acquireOnce(paths: LockPaths, allowRetryOnEexist: boolean): Promise<LockResult> {
  const { socketPath, lockPath } = paths;

  if (await probeSocket(socketPath)) {
    return { alreadyRunning: true, paths };
  }

  const lock = readLock(lockPath);
  if (lock) {
    const ageMs = Date.now() - lock.startedAt;
    if (ageMs < 3000) {
      const cameUp = await waitForSocket(socketPath, 5000);
      if (cameUp) {
        return { alreadyRunning: true, paths };
      }
      // Peer never came up within the wait window — treat the lock as stale.
    }
  }

  // Stale or absent: break it and retake it.
  try { fs.unlinkSync(lockPath); } catch { /* absent is fine */ }
  try { fs.unlinkSync(socketPath); } catch { /* absent is fine */ }

  const contents: LockFileContents = { pid: process.pid, startedAt: Date.now() };
  const wrote = writeLockExclusive(lockPath, contents);
  if (!wrote) {
    if (allowRetryOnEexist) {
      return acquireOnce(paths, false);
    }
    throw new Error("[instanceLock] Failed to acquire daemon lock: EEXIST on both attempts");
  }

  await new Promise(resolve => setTimeout(resolve, 50));
  const confirmed = readLock(lockPath);
  if (!confirmed || confirmed.pid !== process.pid) {
    throw new Error("[instanceLock] Lock confirmation failed — another process claimed it concurrently");
  }

  return { alreadyRunning: false, paths };
}

export async function acquireDaemonLock(): Promise<LockResult> {
  const paths: LockPaths = { socketPath: getSocketPath(), lockPath: getLockPath() };
  return acquireOnce(paths, true);
}

export function releaseDaemonLock(paths: LockPaths): void {
  const lock = readLock(paths.lockPath);
  if (lock && lock.pid === process.pid) {
    try { fs.unlinkSync(paths.lockPath); } catch { /* already gone */ }
  }
  try { fs.unlinkSync(paths.socketPath); } catch { /* already gone */ }
}
