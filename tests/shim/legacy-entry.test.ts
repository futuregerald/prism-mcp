import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ensureShimBuilt,
  freshDataDir,
  makeShimEnv,
  wrapNdjsonClient,
  initializeRequest,
  initializedNotification,
  readLockPid,
  killProc,
  terminateAllDaemonsForCreatedDataDirs,
  waitFor,
} from "./helpers.js";

ensureShimBuilt();

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const LEGACY_ENTRY = path.join(REPO_ROOT, "dist", "server.js");

const spawned: ChildProcess[] = [];

function spawnLegacy(dataDir: string, flag: string | undefined): ChildProcess {
  const env = makeShimEnv(dataDir, dataDir);
  if (flag === undefined) delete env.PRISM_SHARED_DAEMON; else env.PRISM_SHARED_DAEMON = flag;
  const child = spawn(process.execPath, [LEGACY_ENTRY], { env, stdio: ["pipe", "pipe", "pipe"] });
  spawned.push(child);
  return child;
}

function footprintMB(pid: number): number | null {
  if (process.platform !== "darwin") return null;
  try {
    const out = execFileSync("footprint", ["-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const match = out.match(/Footprint: ([\d.]+) (KB|MB|GB)/);
    if (!match) return null;
    const value = Number(match[1]);
    return match[2] === "GB" ? value * 1024 : match[2] === "KB" ? value / 1024 : value;
  } catch {
    return null;
  }
}

async function handshakeAndListTools(child: ChildProcess): Promise<number> {
  const client = wrapNdjsonClient(child);
  client.send(initializeRequest(1));
  const init = await client.waitFor(1, 30_000);
  expect(init.result).toBeDefined();
  client.send(initializedNotification());
  client.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const tools = await client.waitFor(2, 30_000);
  return tools.result.tools.length;
}

afterEach(async () => {
  for (const child of spawned) await killProc(child, "SIGTERM");
  spawned.length = 0;
  await terminateAllDaemonsForCreatedDataDirs();
});

const stdioPidFile = (dataDir: string) => path.join(dataDir, "server-default.pid");
const unixOnly = process.platform === "win32" ? it.skip : it;

describe("legacy dist/server.js entry", () => {
  unixOnly("with the shared-daemon marker, becomes a small shim that talks to a spawned daemon", async () => {
    const dataDir = freshDataDir();
    fs.writeFileSync(path.join(dataDir, "shared-daemon"), "");
    const child = spawnLegacy(dataDir, undefined);

    const toolCount = await handshakeAndListTools(child);
    expect(toolCount).toBeGreaterThan(20);

    await waitFor(() => readLockPid(dataDir) !== null, 15_000);
    expect(readLockPid(dataDir)).not.toBe(child.pid);
    expect(fs.existsSync(stdioPidFile(dataDir))).toBe(false);

    const mb = footprintMB(child.pid!);
    if (mb !== null) expect(mb).toBeLessThan(60);
  }, 60_000);

  unixOnly("PRISM_SHARED_DAEMON=true without a marker also becomes a shim", async () => {
    const dataDir = freshDataDir();
    const child = spawnLegacy(dataDir, "true");

    const toolCount = await handshakeAndListTools(child);
    expect(toolCount).toBeGreaterThan(20);
    await waitFor(() => readLockPid(dataDir) !== null, 15_000);
    expect(fs.existsSync(stdioPidFile(dataDir))).toBe(false);
  }, 60_000);

  it("PRISM_SHARED_DAEMON=false forces the in-process stdio server even with the marker", async () => {
    const dataDir = freshDataDir();
    fs.writeFileSync(path.join(dataDir, "shared-daemon"), "");
    const child = spawnLegacy(dataDir, "false");

    const toolCount = await handshakeAndListTools(child);
    expect(toolCount).toBeGreaterThan(20);
    expect(fs.existsSync(path.join(dataDir, "prismd.lock"))).toBe(false);
    expect(fs.existsSync(stdioPidFile(dataDir))).toBe(true);
  }, 60_000);

  it("without the marker, stays the in-process stdio server", async () => {
    const dataDir = freshDataDir();
    const child = spawnLegacy(dataDir, undefined);

    const toolCount = await handshakeAndListTools(child);
    expect(toolCount).toBeGreaterThan(20);
    expect(fs.existsSync(path.join(dataDir, "prismd.lock"))).toBe(false);
    expect(fs.existsSync(stdioPidFile(dataDir))).toBe(true);
  }, 60_000);
});
