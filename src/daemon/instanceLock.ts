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

export function readLock(lockPath: string): LockFileContents | null {
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

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const LOCK_PID_ALIVE_WAIT_MS = 30_000;

async function waitForPidExitOrSocket(
  pid: number,
  socketPath: string,
  maxWaitMs: number
): Promise<"socket" | "pid-exited" | "timeout"> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await probeSocket(socketPath, 200)) return "socket";
    if (!isPidAlive(pid)) return "pid-exited";
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return "timeout";
}

function safeUnlinkSocket(socketPath: string): void {
  try {
    const st = fs.lstatSync(socketPath);
    if (st.isSocket()) fs.unlinkSync(socketPath);
  } catch { }
}

async function acquireOnce(paths: LockPaths, allowRetryOnEexist: boolean): Promise<LockResult> {
  const { socketPath, lockPath } = paths;

  if (await probeSocket(socketPath)) {
    return { alreadyRunning: true, paths };
  }

  const lock = readLock(lockPath);
  if (lock) {
    if (isPidAlive(lock.pid)) {
      const outcome = await waitForPidExitOrSocket(lock.pid, socketPath, LOCK_PID_ALIVE_WAIT_MS);
      if (outcome === "socket") {
        return { alreadyRunning: true, paths };
      }
      if (outcome === "timeout" && (await probeSocket(socketPath))) {
        return { alreadyRunning: true, paths };
      }
    }

    const ageMs = Date.now() - lock.startedAt;
    if (ageMs < 3000) {
      const cameUp = await waitForSocket(socketPath, 5000);
      if (cameUp) {
        return { alreadyRunning: true, paths };
      }
    }
  }

  try { fs.unlinkSync(lockPath); } catch { }
  safeUnlinkSocket(socketPath);

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

export function claimLockAsSocketOwner(paths: LockPaths, startedAt: number): void {
  const current = readLock(paths.lockPath);
  if (current && current.pid === process.pid) return;
  const tmpPath = `${paths.lockPath}.${process.pid}.tmp`;
  const contents: LockFileContents = { pid: process.pid, startedAt };
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(contents), { mode: 0o600 });
    fs.renameSync(tmpPath, paths.lockPath);
  } catch {
    try { fs.unlinkSync(tmpPath); } catch { }
  }
}

export function releaseDaemonLock(paths: LockPaths, ownInode: number): void {
  const lock = readLock(paths.lockPath);
  if (lock && lock.pid === process.pid) {
    try { fs.unlinkSync(paths.lockPath); } catch { }
  }
  try {
    const st = fs.lstatSync(paths.socketPath);
    if (st.isSocket() && st.ino === ownInode) {
      fs.unlinkSync(paths.socketPath);
    }
  } catch { }
}
