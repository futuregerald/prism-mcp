import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ChildProcess } from "node:child_process";
import {
  ensureShimBuilt,
  freshDataDir,
  spawnShim,
  wrapNdjsonClient,
  initializeRequest,
  initializedNotification,
  toolCallRequest,
  readLockPid,
  pidIsAlive,
  terminatePid,
  killProc,
  waitFor,
  type NdjsonClient,
} from "./helpers.js";

ensureShimBuilt();

const spawnedShims: ChildProcess[] = [];
const spawnedDaemonPids = new Set<number>();

function trackShim(child: ChildProcess): ChildProcess {
  spawnedShims.push(child);
  return child;
}

function trackDaemonFrom(dataDir: string): number | null {
  const pid = readLockPid(dataDir);
  if (pid) spawnedDaemonPids.add(pid);
  return pid;
}

async function handshake(client: NdjsonClient, id: number | string = 1): Promise<void> {
  client.send(initializeRequest(id));
  const initResp = await client.waitFor(id, 20_000);
  expect(initResp.result).toBeDefined();
  client.send(initializedNotification());
}

afterEach(async () => {
  for (const child of spawnedShims) {
    await killProc(child, "SIGTERM");
  }
  spawnedShims.length = 0;
  for (const pid of spawnedDaemonPids) {
    await terminatePid(pid);
  }
  spawnedDaemonPids.clear();
});

describe("shim + daemon integration", () => {
  it("auto-spawns the daemon; initialize + tools/list works", async () => {
    const dataDir = freshDataDir();
    const child = trackShim(spawnShim(dataDir, dataDir));
    const client = wrapNdjsonClient(child);

    await handshake(client, 1);

    client.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const toolsResp = await client.waitFor(2, 20_000);
    expect(Array.isArray(toolsResp.result.tools)).toBe(true);
    expect(toolsResp.result.tools.length).toBeGreaterThan(0);

    await waitFor(() => readLockPid(dataDir) !== null, 10_000, 100);
    const pid = trackDaemonFrom(dataDir);
    expect(pid).not.toBeNull();
    expect(pidIsAlive(pid!)).toBe(true);
  }, 30_000);

  it("recovers a killed daemon: session_save_handoff survives a SIGKILL and is visible via session_load_context", async () => {
    const dataDir = freshDataDir();
    const child = trackShim(spawnShim(dataDir, dataDir));
    const client = wrapNdjsonClient(child);

    await handshake(client, 1);

    const distinctiveSummary = `phase4-shim-test-${Date.now()}`;
    client.send(toolCallRequest(2, "session_save_handoff", {
      project: "phase4-shim-test",
      last_summary: distinctiveSummary,
    }));
    const saveResp = await client.waitFor(2, 20_000);
    expect(saveResp.result).toBeDefined();
    expect(saveResp.result.isError).not.toBe(true);

    await waitFor(() => readLockPid(dataDir) !== null, 10_000, 100);
    const pid = trackDaemonFrom(dataDir);
    expect(pid).not.toBeNull();
    process.kill(pid!, "SIGKILL");
    await waitFor(() => !pidIsAlive(pid!), 5_000, 100);

    client.send(toolCallRequest(3, "session_load_context", {
      project: "phase4-shim-test",
      level: "quick",
    }));
    const loadResp = await client.waitFor(3, 45_000);

    expect(loadResp.error?.code).not.toBe(-32000);
    expect(JSON.stringify(loadResp)).toContain(distinctiveSummary);

    const newPid = trackDaemonFrom(dataDir);
    expect(newPid).not.toBeNull();
    expect(newPid).not.toBe(pid);
  }, 60_000);

  it("throttles simultaneous spawns: two shims racing on the same fresh data dir end up with exactly one live daemon", async () => {
    const dataDir = freshDataDir();
    const childA = trackShim(spawnShim(dataDir, dataDir, { PRISM_SHIM_DEBUG: "1" }));
    const childB = trackShim(spawnShim(dataDir, dataDir, { PRISM_SHIM_DEBUG: "1" }));
    const clientA = wrapNdjsonClient(childA);
    const clientB = wrapNdjsonClient(childB);

    await Promise.all([handshake(clientA, 1), handshake(clientB, 1)]);

    clientA.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    clientB.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const [toolsA, toolsB] = await Promise.all([
      clientA.waitFor(2, 20_000),
      clientB.waitFor(2, 20_000),
    ]);
    expect(Array.isArray(toolsA.result.tools)).toBe(true);
    expect(Array.isArray(toolsB.result.tools)).toBe(true);

    await new Promise(resolve => setTimeout(resolve, 300));

    const combinedStderr = clientA.stderrOutput() + clientB.stderrOutput();
    const spawnCount = (combinedStderr.match(/spawning daemon:/g) || []).length;
    expect(spawnCount).toBe(1);

    const pid = trackDaemonFrom(dataDir);
    expect(pid).not.toBeNull();
    expect(pidIsAlive(pid!)).toBe(true);
  }, 30_000);

  it("replays an in-flight mutating request across a SIGKILL and gets exactly one response after reconnect", async () => {
    const dataDir = freshDataDir();
    const child = trackShim(spawnShim(dataDir, dataDir, { PRISM_TEST_SAVE_DELAY_MS: "3000" }));
    const client = wrapNdjsonClient(child);

    await handshake(client, 1);

    client.send(toolCallRequest(2, "session_save_ledger", {
      project: "phase4-shim-test",
      conversation_id: `phase4-conv-${Date.now()}`,
      summary: "in-flight save held by PRISM_TEST_SAVE_DELAY_MS",
    }));

    await waitFor(() => readLockPid(dataDir) !== null, 10_000, 100);
    await new Promise(resolve => setTimeout(resolve, 1_000));

    const pid = trackDaemonFrom(dataDir);
    expect(pid).not.toBeNull();
    process.kill(pid!, "SIGKILL");
    await waitFor(() => !pidIsAlive(pid!), 5_000, 100);

    const response = await client.waitFor(2, 45_000);
    expect(response.id).toBe(2);
    expect(response.error?.code).not.toBe(-32000);

    const newPid = trackDaemonFrom(dataDir);
    expect(newPid).not.toBeNull();
    expect(newPid).not.toBe(pid);
  }, 60_000);
});
