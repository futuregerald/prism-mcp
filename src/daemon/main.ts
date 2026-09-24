/**
 * The daemon's real entry point — everything that daemon.ts deliberately
 * avoids importing until after the lock/socket probe has decided this
 * process should keep running.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import { createServer, startBackgroundServices, getInFlightCount } from "../server.js";
import { startStorage } from "../storageReady.js";
import { initConfigStorage } from "../storage/configStorage.js";
import { initTelemetry } from "../utils/telemetry.js";
import { registerServer, unregisterServer } from "../connectionRegistry.js";
import { runWithRequestContext } from "../utils/requestContext.js";
import { performResourceCleanup } from "../lifecycle.js";
import { releaseDaemonLock, type LockPaths } from "./instanceLock.js";

function log(msg: string): void {
  console.error(`[prism-daemon] ${msg}`);
}

interface HelloResult {
  cwd?: string;
  clientId?: string;
}

/**
 * Reads the first '\n'-terminated line from a freshly-accepted socket. If it
 * parses as a `{"prism_hello": {...}}` envelope, returns its cwd/clientId and
 * pushes any bytes after the newline back onto the socket (R1) *before* the
 * transport is created, so a hello + initialize + tools/list sent in one
 * `write()` all still get answered. If the first line isn't a hello, the
 * whole thing (unparsed) is pushed back and treated as plain MCP framing
 * with an empty request context.
 */
function readHello(socket: net.Socket): Promise<HelloResult> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);

    const onError = (err: Error) => {
      socket.off("data", onData);
      socket.off("error", onError);
      reject(err);
    };

    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const newlineIdx = buffered.indexOf(0x0a);
      if (newlineIdx === -1) return;

      // Pause BEFORE removing the listener: a flowing Readable with zero
      // 'data' listeners keeps draining its internal buffer into the void,
      // silently discarding whatever we unshift() below. Pausing first
      // holds the unshifted bytes in the buffer until handleConnection
      // explicitly resumes the socket once the real transport is wired up.
      socket.pause();
      socket.off("data", onData);
      socket.off("error", onError);

      const firstLine = buffered.subarray(0, newlineIdx).toString("utf8");
      const rest = buffered.subarray(newlineIdx + 1);

      try {
        const parsed = JSON.parse(firstLine);
        if (parsed && parsed.prism_hello && parsed.prism_hello.v === 1) {
          if (rest.length > 0) {
            socket.unshift(rest);
          }
          resolve({ cwd: parsed.prism_hello.cwd, clientId: parsed.prism_hello.clientId });
          return;
        }
      } catch {
        // Not JSON — falls through to the "not a hello" branch below.
      }

      // Not a hello line: push the whole thing back verbatim (newline
      // included) so the MCP transport sees the exact bytes the client sent.
      socket.unshift(buffered);
      resolve({});
    };

    socket.on("data", onData);
    socket.on("error", onError);
  });
}

async function handleConnection(socket: net.Socket): Promise<void> {
  let hello: HelloResult;
  try {
    hello = await readHello(socket);
  } catch (err) {
    log(`hello read failed (non-fatal, dropping connection): ${err instanceof Error ? err.message : String(err)}`);
    socket.destroy();
    return;
  }

  const server = createServer();
  const transport = new StdioServerTransport(socket, socket);

  await server.connect(transport);

  // Protocol.connect() REPLACES transport.onmessage, so we must wrap it
  // AFTER connect() returns — wrapping before would just get overwritten.
  const connected = transport.onmessage;
  transport.onmessage = (message: JSONRPCMessage) => {
    runWithRequestContext({ cwd: hello.cwd, clientId: hello.clientId }, () => {
      connected?.(message);
    });
  };

  // readHello() paused the socket to protect the unshifted bytes (see its
  // comment). transport.start() (inside connect(), above) added its own
  // 'data' listener but never un-paused the socket, so we must resume it
  // ourselves or the transport never sees another byte.
  socket.resume();

  registerServer(server);

  const cleanup = () => {
    unregisterServer(server);
    server.close().catch(() => { /* best-effort */ });
  };
  socket.once("close", cleanup);
  socket.once("error", cleanup);
}

export async function runDaemonMain(paths: LockPaths): Promise<void> {
  await initConfigStorage();
  initTelemetry();
  await startStorage();
  startBackgroundServices();

  const connections = new Set<net.Socket>();
  const idleExitMs = parseInt(process.env.PRISM_DAEMON_IDLE_EXIT_MS ?? "1800000", 10);
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
    handleConnection(socket).catch(err => {
      log(`Connection handler failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

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

  async function gracefulShutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    clearIdleTimer();
    clearInterval(inodeCheckInterval);
    log(`Shutting down gracefully (${reason})...`);

    server.close();

    const drainStart = Date.now();
    while (getInFlightCount() > 0 && Date.now() - drainStart < 10_000) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    for (const socket of connections) {
      try { socket.end(); } catch { /* best-effort */ }
    }

    try {
      await performResourceCleanup(log);
    } catch (err) {
      log(`Error during resource cleanup: ${err instanceof Error ? err.message : String(err)}`);
    }

    releaseDaemonLock(paths);
    process.exit(0);
  }

  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
  process.on("SIGHUP", () => void gracefulShutdown("SIGHUP"));
}
