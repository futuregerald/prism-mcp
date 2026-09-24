import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  ensureShimBuilt,
  freshDataDir,
  makeShimEnv,
  wrapNdjsonClient,
  initializeRequest,
  initializedNotification,
  toolCallRequest,
  killProc,
  waitFor,
} from "./helpers.js";
import { spawn } from "node:child_process";

ensureShimBuilt();

function listenStalledDaemon(socketPath: string): { server: net.Server; sockets: net.Socket[] } {
  const sockets: net.Socket[] = [];
  const server = net.createServer(socket => {
    sockets.push(socket);
    socket.pause();
  });
  server.listen(socketPath);
  return { server, sockets };
}

function listenRespondingDaemon(socketPath: string): net.Server {
  const server = net.createServer(socket => {
    let buffered = "";
    socket.on("data", chunk => {
      buffered += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, idx);
        buffered = buffered.slice(idx + 1);
        if (!line.trim()) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.prism_hello) continue;
        if (msg.id !== undefined) {
          socket.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }) + "\n");
        }
      }
    });
  });
  server.listen(socketPath);
  return server;
}

describe("shim stdin backpressure recovery (A1)", () => {
  let shim: ChildProcess | undefined;
  const servers: net.Server[] = [];

  afterEach(async () => {
    if (shim) await killProc(shim, "SIGKILL");
    shim = undefined;
    for (const server of servers.splice(0)) {
      try { server.close(); } catch { }
    }
  });

  it("resumes stdin after the socket closes while backpressured, so a later request still gets answered on reconnect", async () => {
    const dataDir = freshDataDir();
    const socketPath = path.join(dataDir, "fake.sock");
    const noopDaemonPath = path.join(dataDir, "noop-daemon.js");
    fs.writeFileSync(noopDaemonPath, "");

    const stalled = listenStalledDaemon(socketPath);
    servers.push(stalled.server);

    shim = spawn(process.execPath, [path.resolve("dist/shim.js")], {
      env: makeShimEnv(dataDir, dataDir, {
        PRISM_SOCKET: socketPath,
        PRISM_DAEMON_PATH: noopDaemonPath,
      }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = wrapNdjsonClient(shim);

    await waitFor(() => stalled.sockets.length > 0, 10_000, 50);

    const bigArgument = "x".repeat(8 * 1024 * 1024);
    client.send(toolCallRequest(1, "session_load_context", { project: bigArgument }));

    await new Promise(resolve => setTimeout(resolve, 500));

    for (const socket of stalled.sockets) {
      socket.destroy();
    }
    await new Promise<void>(resolve => stalled.server.close(() => resolve()));
    try { fs.unlinkSync(socketPath); } catch { }

    const responding = listenRespondingDaemon(socketPath);
    servers.push(responding);

    client.send(toolCallRequest(2, "session_load_context", { project: "after-reconnect" }));
    const response = await client.waitFor(2, 15_000);
    expect(response.result?.ok).toBe(true);
  }, 30_000);
});
