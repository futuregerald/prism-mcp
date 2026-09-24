import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const DAEMON_ENTRY = path.join(REPO_ROOT, "dist", "daemon.js");

export function getDaemonEntry(): string {
  return DAEMON_ENTRY;
}

export function ensureDaemonBuilt(): void {
  if (!fs.existsSync(DAEMON_ENTRY)) {
    throw new Error(`Build missing — run npm run build before this suite (expected ${DAEMON_ENTRY})`);
  }
}

export interface DaemonEnvOverrides {
  [key: string]: string;
}

export function makeDaemonEnv(home: string, dataDir: string, overrides: DaemonEnvOverrides = {}): NodeJS.ProcessEnv {
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

export function spawnDaemon(home: string, dataDir: string, overrides: DaemonEnvOverrides = {}): ChildProcess {
  return spawn(process.execPath, [getDaemonEntry()], {
    env: makeDaemonEnv(home, dataDir, overrides),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function getSocketPath(dataDir: string): string {
  return path.join(dataDir, "prismd.sock");
}

export function probeSocket(socketPath: string, timeoutMs = 300): Promise<boolean> {
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

export async function waitForSocket(socketPath: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probeSocket(socketPath)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for daemon socket at ${socketPath}`);
}

export function killProc(proc: ChildProcess): Promise<void> {
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
      proc.kill("SIGTERM");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

interface PendingEntry {
  resolve: (msg: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface RawJsonRpcClient {
  socket: net.Socket;
  write(raw: string): void;
  send(msg: unknown): void;
  waitFor(id: number | string, timeoutMs?: number): Promise<any>;
  notifications: any[];
  close(): void;
}

export function connectRawClient(socketPath: string): Promise<RawJsonRpcClient> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    const pending = new Map<string | number, PendingEntry>();
    const notifications: any[] = [];

    socket.on("data", chunk => {
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
        if (msg.id !== undefined && pending.has(msg.id)) {
          const entry = pending.get(msg.id)!;
          pending.delete(msg.id);
          clearTimeout(entry.timer);
          entry.resolve(msg);
        } else {
          notifications.push(msg);
        }
      }
    });

    socket.once("connect", () => {
      resolve({
        socket,
        notifications,
        write(raw: string) {
          socket.write(raw);
        },
        send(msg: unknown) {
          socket.write(JSON.stringify(msg) + "\n");
        },
        waitFor(id, timeoutMs = 10_000) {
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`Timed out waiting for response id=${String(id)}`));
            }, timeoutMs);
            pending.set(id, { resolve: res, reject: rej, timer });
          });
        },
        close() {
          socket.end();
        },
      });
    });
    socket.once("error", reject);
  });
}

export function helloLine(cwd: string, clientId: string): string {
  return JSON.stringify({ prism_hello: { v: 1, cwd, clientId } }) + "\n";
}

export function initializeRequest(id: number | string = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "prism-daemon-test", version: "0.0.0" },
    },
  };
}

export function initializedNotification() {
  return { jsonrpc: "2.0", method: "notifications/initialized" };
}
