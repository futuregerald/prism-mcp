import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const SHIM_ENTRY = path.join(REPO_ROOT, "dist", "shim.js");
export const DAEMON_ENTRY = path.join(REPO_ROOT, "dist", "daemon.js");

export function ensureShimBuilt(): void {
  if (!fs.existsSync(SHIM_ENTRY) || !fs.existsSync(DAEMON_ENTRY)) {
    throw new Error(
      `Build missing — run npm run build before this suite (expected ${SHIM_ENTRY} and ${DAEMON_ENTRY})`
    );
  }
}

const createdDataDirs = new Set<string>();

export function freshDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prs-"));
  createdDataDirs.add(dir);
  return dir;
}

export function daemonPidsForDataDir(dataDir: string): number[] {
  let listing = "";
  try {
    listing = execFileSync("ps", ["-ax", "-o", "pid=,args="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return [];
  }
  const daemonPids = listing
    .split("\n")
    .map(line => line.trim().split(/\s+/))
    .filter(fields => fields.length >= 3 && fields[2].endsWith("dist/daemon.js"))
    .map(fields => parseInt(fields[0], 10))
    .filter(pid => Number.isFinite(pid) && pid !== process.pid);
  return daemonPids.filter(pid => pidHasEnvAssignment(pid, `PRISM_DATA_DIR=${dataDir}`));
}

function pidHasEnvAssignment(pid: number, envAssignment: string): boolean {
  if (process.platform === "linux") {
    try {
      const environ = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
      return environ.split("\0").includes(envAssignment);
    } catch {
      return false;
    }
  }
  try {
    const withEnv = execFileSync("ps", ["-E", "-p", String(pid), "-o", "args="], { encoding: "utf8" });
    return withEnv.includes(`${envAssignment} `) || withEnv.trimEnd().endsWith(envAssignment);
  } catch {
    return false;
  }
}

export async function terminateAllDaemonsForCreatedDataDirs(): Promise<void> {
  for (const dir of createdDataDirs) {
    for (const pid of daemonPidsForDataDir(dir)) {
      await terminatePid(pid);
    }
  }
}

export interface EnvOverrides {
  [key: string]: string;
}

export function makeShimEnv(home: string, dataDir: string, overrides: EnvOverrides = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    PRISM_DATA_DIR: dataDir,
    PRISM_STORAGE: "local",
    PRISM_SCHEDULER_ENABLED: "false",
    PRISM_DAEMON_IDLE_EXIT_MS: "60000",
    PRISM_ENABLE_HIVEMIND: "false",
    PRISM_ENABLE_DASHBOARD: "false",
    ...overrides,
  };
}

export function spawnShim(home: string, dataDir: string, overrides: EnvOverrides = {}): ChildProcess {
  return spawn(process.execPath, [SHIM_ENTRY], {
    env: makeShimEnv(home, dataDir, overrides),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function getLockPath(dataDir: string): string {
  return path.join(dataDir, "prismd.lock");
}

export function getSpawnMarkerPath(dataDir: string): string {
  return path.join(dataDir, "prismd.spawn");
}

export function readLockPid(dataDir: string): number | null {
  try {
    const raw = fs.readFileSync(getLockPath(dataDir), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.pid === "number" ? parsed.pid : null;
  } catch {
    return null;
  }
}

export async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 100): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition");
}

export function killProc(proc: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  return new Promise(resolve => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { }
    }, 3000);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      proc.kill(signal);
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

export function killPid(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
  try {
    process.kill(pid, signal);
  } catch {
  }
}

export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function terminatePid(pid: number): Promise<void> {
  if (!pidIsAlive(pid)) return;
  killPid(pid, "SIGTERM");
  try {
    await waitFor(() => !pidIsAlive(pid), 2000, 100);
  } catch {
    killPid(pid, "SIGKILL");
  }
}

interface PendingEntry {
  resolve: (msg: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface NdjsonClient {
  child: ChildProcess;
  send(msg: unknown): void;
  waitFor(id: number | string, timeoutMs?: number): Promise<any>;
  stderrOutput(): string;
  stdoutLines: any[];
}

export function wrapNdjsonClient(child: ChildProcess): NdjsonClient {
  let buffer = "";
  const pending = new Map<string | number, PendingEntry>();
  const stdoutLines: any[] = [];
  let stderrBuf = "";

  child.stdout?.on("data", chunk => {
    buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      stdoutLines.push(msg);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const entry = pending.get(msg.id)!;
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.resolve(msg);
      }
    }
  });

  child.stderr?.on("data", chunk => {
    stderrBuf += chunk.toString("utf8");
  });

  return {
    child,
    send(msg: unknown) {
      child.stdin?.write(JSON.stringify(msg) + "\n");
    },
    waitFor(id, timeoutMs = 15_000) {
      return new Promise((res, rej) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rej(new Error(`Timed out waiting for response id=${String(id)}`));
        }, timeoutMs);
        pending.set(id, { resolve: res, reject: rej, timer });
      });
    },
    stderrOutput() {
      return stderrBuf;
    },
    stdoutLines,
  };
}

export function initializeRequest(id: number | string = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "prism-shim-test", version: "0.0.0" },
    },
  };
}

export function initializedNotification() {
  return { jsonrpc: "2.0", method: "notifications/initialized" };
}

export function toolCallRequest(id: number | string, name: string, args: Record<string, unknown> = {}) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}
