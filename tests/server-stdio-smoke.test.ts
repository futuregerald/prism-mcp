import { describe, it, expect, afterEach } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const SERVER_ENTRY = path.join(REPO_ROOT, "dist", "server.js");

function ensureBuilt(): void {
  if (!fs.existsSync(SERVER_ENTRY)) {
    execSync("npm run build", { cwd: REPO_ROOT, stdio: "pipe" });
  }
}

describe("stdio mode still works after the Phase 2 refactor", () => {
  let proc: ChildProcess | undefined;

  afterEach(() => {
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGTERM");
    }
    proc = undefined;
  });

  it("answers initialize and tools/list over stdio", async () => {
    ensureBuilt();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "prd-stdio-"));

    const stdioEnv: NodeJS.ProcessEnv = { ...process.env };
    delete stdioEnv.PRISM_SHARED_DAEMON;
    proc = spawn(process.execPath, [SERVER_ENTRY], {
      env: {
        ...stdioEnv,
        HOME: home,
        PRISM_DATA_DIR: home,
        PRISM_STORAGE: "local",
        PRISM_SCHEDULER_ENABLED: "false",
        PRISM_ENABLE_HIVEMIND: "false",
        PRISM_ENABLE_DASHBOARD: "false",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buffer = "";
    const pending = new Map<number, (msg: any) => void>();
    proc.stdout!.on("data", chunk => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && pending.has(msg.id)) {
            const resolve = pending.get(msg.id)!;
            pending.delete(msg.id);
            resolve(msg);
          }
        } catch { }
      }
    });

    const waitFor = (id: number, timeoutMs = 15_000) =>
      new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for id=${id}`));
        }, timeoutMs);
        pending.set(id, msg => {
          clearTimeout(timer);
          resolve(msg);
        });
      });

    const send = (msg: unknown) => {
      proc!.stdin!.write(JSON.stringify(msg) + "\n");
    };

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "stdio-smoke-test", version: "0.0.0" },
      },
    });
    const initResponse = await waitFor(1);
    expect(initResponse.result).toBeDefined();
    expect(initResponse.result.serverInfo).toBeDefined();

    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const toolsResponse = await waitFor(2);
    expect(Array.isArray(toolsResponse.result.tools)).toBe(true);
    expect(toolsResponse.result.tools.length).toBeGreaterThan(0);
  }, 30_000);
});
