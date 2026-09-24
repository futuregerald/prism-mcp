import * as fs from "node:fs";
import * as net from "node:net";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import { createServer, startBackgroundServices, getInFlightCount, beginRejectingNewToolCalls, holdNewToolCallsUnansweredDuringShutdown } from "../server.js";
import { startStorage, getStorageReadyPromise } from "../storageReady.js";
import { initConfigStorage } from "../storage/configStorage.js";
import { initTelemetry } from "../utils/telemetry.js";
import { registerServer, unregisterServer } from "../connectionRegistry.js";
import { runWithRequestContext } from "../utils/requestContext.js";
import { performResourceCleanup } from "../lifecycle.js";
import { releaseDaemonLock, type LockPaths } from "./instanceLock.js";
import { computeConfigFingerprint } from "../utils/configFingerprint.js";
import { parsePositiveIntEnv } from "../utils/envInt.js";

function log(msg: string): void {
  console.error(`[prism-daemon] ${msg}`);
}

const OWN_CONFIG_FINGERPRINT = computeConfigFingerprint();

interface HelloResult {
  cwd?: string;
  clientId?: string;
  configFingerprint?: string;
}

interface AdminHello {
  action: string;
}

const HELLO_MAX_BYTES = 4096;
const HELLO_TIMEOUT_MS = 5000;

function pauseSocketToProtectUnshiftedBytes(
  socket: net.Socket,
  onData: (chunk: Buffer) => void,
  onError: (err: Error) => void
): void {
  socket.pause();
  socket.off("data", onData);
  socket.off("error", onError);
}

function resumeSocketAfterTransportWired(socket: net.Socket): void {
  socket.resume();
}

const STORAGE_READY_TIMEOUT_MS = 30_000;

async function waitForStorageReady(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let promise = getStorageReadyPromise();
  while (!promise) {
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 10));
    promise = getStorageReadyPromise();
  }

  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return false;

  const TIMEOUT = Symbol("storage-ready-timeout");
  const result = await Promise.race([
    promise.then(() => true as const),
    new Promise<typeof TIMEOUT>(resolve => setTimeout(() => resolve(TIMEOUT), remainingMs)),
  ]);
  return result !== TIMEOUT;
}

function readHello(socket: net.Socket): Promise<HelloResult | AdminHello> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    let settled = false;

    const finishWith = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const onError = (err: Error) => {
      finishWith(() => {
        socket.off("data", onData);
        socket.off("error", onError);
        reject(err);
      });
    };

    const timer = setTimeout(() => {
      finishWith(() => {
        socket.off("data", onData);
        socket.off("error", onError);
        socket.destroy();
        reject(new Error("hello read timed out"));
      });
    }, HELLO_TIMEOUT_MS);

    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const newlineIdx = buffered.indexOf(0x0a);
      if (newlineIdx === -1) {
        if (buffered.length > HELLO_MAX_BYTES) {
          finishWith(() => {
            socket.off("data", onData);
            socket.off("error", onError);
            socket.destroy();
            reject(new Error("hello line exceeded max size"));
          });
        }
        return;
      }

      finishWith(() => {
        pauseSocketToProtectUnshiftedBytes(socket, onData, onError);

        const firstLine = buffered.subarray(0, newlineIdx).toString("utf8");
        const rest = buffered.subarray(newlineIdx + 1);

        try {
          const parsed = JSON.parse(firstLine);
          if (parsed && parsed.prism_admin && parsed.prism_admin.v === 1) {
            if (rest.length > 0) {
              socket.unshift(rest);
            }
            resolve({ action: parsed.prism_admin.action });
            return;
          }
          if (parsed && parsed.prism_hello && parsed.prism_hello.v === 1) {
            if (rest.length > 0) {
              socket.unshift(rest);
            }
            resolve({
              cwd: parsed.prism_hello.cwd,
              clientId: parsed.prism_hello.clientId,
              configFingerprint: parsed.prism_hello.configFingerprint,
            });
            return;
          }
        } catch {
        }

        socket.unshift(buffered);
        resolve({});
      });
    };

    socket.on("data", onData);
    socket.on("error", onError);
  });
}

const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024;

function destroySocketOnOversizedLine(socket: net.Socket, maxLineBytes: number): void {
  let bytesSinceNewline = 0;
  socket.on("data", (chunk: Buffer) => {
    const lastNewline = chunk.lastIndexOf(0x0a);
    bytesSinceNewline = lastNewline === -1 ? bytesSinceNewline + chunk.length : chunk.length - lastNewline - 1;
    if (bytesSinceNewline > maxLineBytes) {
      log(`Closing connection: a single line exceeded ${maxLineBytes} bytes`);
      socket.destroy();
    }
  });
}

function isAdminHello(hello: HelloResult | AdminHello): hello is AdminHello {
  return typeof (hello as AdminHello).action === "string";
}

async function handleConnection(
  socket: net.Socket,
  requestShutdown: (reason: string) => void
): Promise<void> {
  let hello: HelloResult | AdminHello;
  try {
    hello = await readHello(socket);
  } catch (err) {
    log(`hello read failed (non-fatal, dropping connection): ${err instanceof Error ? err.message : String(err)}`);
    socket.destroy();
    return;
  }

  if (isAdminHello(hello)) {
    if (hello.action === "shutdown") {
      socket.end();
      requestShutdown("admin-shutdown");
    } else {
      socket.destroy();
    }
    return;
  }

  const storageReady = await waitForStorageReady(STORAGE_READY_TIMEOUT_MS);
  if (!storageReady) {
    log("Closing MCP connection: storage was not ready within the startup deadline");
    socket.destroy();
    return;
  }

  if (hello.configFingerprint !== undefined && hello.configFingerprint !== OWN_CONFIG_FINGERPRINT) {
    socket.write(JSON.stringify({ prism_hello_error: { reason: "config_mismatch" } }) + "\n");
    socket.end();
    return;
  }

  const server = createServer();
  const transport = new StdioServerTransport(socket, socket);

  await server.connect(transport);

  const connected = transport.onmessage;
  transport.onmessage = (message: JSONRPCMessage) => {
    runWithRequestContext({ cwd: hello.cwd, clientId: hello.clientId }, () => {
      connected?.(message);
    });
  };

  destroySocketOnOversizedLine(socket, parsePositiveIntEnv(process.env.PRISM_DAEMON_MAX_LINE_BYTES, DEFAULT_MAX_LINE_BYTES));

  resumeSocketAfterTransportWired(socket);

  registerServer(server);

  const cleanup = () => {
    unregisterServer(server);
    server.close().catch(() => { });
  };
  socket.once("close", cleanup);
  socket.once("error", cleanup);
}

export async function runDaemonMain(paths: LockPaths): Promise<void> {
  const connections = new Set<net.Socket>();
  const idleExitMs = parsePositiveIntEnv(process.env.PRISM_DAEMON_IDLE_EXIT_MS, 1_800_000);
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let shuttingDown = false;

  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const armIdleTimer = () => {
    if (idleExitMs <= 0 || connections.size > 0 || shuttingDown) return;
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      log(`Idle for ${idleExitMs}ms with zero connections — shutting down`);
      void gracefulShutdown("idle");
    }, idleExitMs);
  };

  const server = net.createServer(socket => {
    connections.add(socket);
    clearIdleTimer();
    socket.once("close", () => {
      connections.delete(socket);
      armIdleTimer();
    });
    handleConnection(socket, reason => void gracefulShutdown(reason)).catch(err => {
      log(`Connection handler failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  const previousUmask = process.umask(0o077);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(paths.socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } finally {
    process.umask(previousUmask);
  }

  fs.chmodSync(paths.socketPath, 0o600);
  log(`Listening on ${paths.socketPath} (pid ${process.pid})`);

  const ownInode = fs.statSync(paths.socketPath).ino;
  const inodeCheckInterval = setInterval(() => {
    try {
      const currentInode = fs.statSync(paths.socketPath).ino;
      if (currentInode !== ownInode) {
        log("Socket path inode changed under us (takeover race) — shutting down");
        void gracefulShutdown("inode-mismatch");
      }
    } catch {
      log("Socket path vanished under us — shutting down");
      void gracefulShutdown("socket-missing");
    }
  }, 5000);
  inodeCheckInterval.unref();

  armIdleTimer();

  const backgroundInit = (async () => {
    await initConfigStorage();
    initTelemetry();
    await startStorage();
    startBackgroundServices();
  })();
  backgroundInit.catch(err => {
    log(`Background initialization failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  async function gracefulShutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    beginRejectingNewToolCalls();
    holdNewToolCallsUnansweredDuringShutdown();
    clearIdleTimer();
    clearInterval(inodeCheckInterval);
    log(`Shutting down gracefully (${reason})...`);

    try {
      const st = fs.lstatSync(paths.socketPath);
      if (st.isSocket() && st.ino === ownInode) {
        fs.unlinkSync(paths.socketPath);
      }
    } catch { }

    server.close();

    const drainStart = Date.now();
    while (getInFlightCount() > 0 && Date.now() - drainStart < 10_000) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    for (const socket of connections) {
      try { socket.end(); } catch { }
    }

    try {
      await performResourceCleanup(log);
    } catch (err) {
      log(`Error during resource cleanup: ${err instanceof Error ? err.message : String(err)}`);
    }

    releaseDaemonLock(paths, ownInode);
    process.exit(0);
  }

  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
  process.on("SIGHUP", () => void gracefulShutdown("SIGHUP"));
}
