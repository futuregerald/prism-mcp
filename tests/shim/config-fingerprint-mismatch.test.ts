import { describe, it, expect, afterEach } from "vitest";
import type { ChildProcess } from "node:child_process";

import {
  ensureShimBuilt,
  freshDataDir,
  spawnShim,
  wrapNdjsonClient,
  initializeRequest,
  initializedNotification,
  killProc,
  terminateAllDaemonsForCreatedDataDirs,
  type NdjsonClient,
} from "./helpers.js";

ensureShimBuilt();

describe("shim + daemon config fingerprint mismatch", () => {
  const spawnedShims: ChildProcess[] = [];

  afterEach(async () => {
    for (const child of spawnedShims.splice(0)) {
      await killProc(child, "SIGTERM");
    }
    await terminateAllDaemonsForCreatedDataDirs();
  });

  it("a second shim with a different PRISM_USER_ID gets -32001 and stops retrying, while the first shim keeps working", async () => {
    const dataDir = freshDataDir();

    const first = spawnShim(dataDir, dataDir, { PRISM_USER_ID: "alice" });
    spawnedShims.push(first);
    const firstClient: NdjsonClient = wrapNdjsonClient(first);

    firstClient.send(initializeRequest(1));
    const firstInit = await firstClient.waitFor(1, 20_000);
    expect(firstInit.result).toBeDefined();
    firstClient.send(initializedNotification());

    const second = spawnShim(dataDir, dataDir, { PRISM_USER_ID: "bob" });
    spawnedShims.push(second);
    const secondClient: NdjsonClient = wrapNdjsonClient(second);

    secondClient.send(initializeRequest(1));
    const secondInit = await secondClient.waitFor(1, 20_000);

    expect(secondInit.error).toBeTruthy();
    expect(secondInit.error.code).toBe(-32001);
    expect(secondInit.error.message).toMatch(/PRISM_USER_ID/);

    firstClient.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const toolsResp = await firstClient.waitFor(2, 20_000);
    expect(toolsResp.result).toBeDefined();

    await new Promise(resolve => setTimeout(resolve, 500));
    secondClient.send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    const secondFollowUp = await secondClient.waitFor(3, 5000);
    expect(secondFollowUp.error?.code).toBe(-32001);
  }, 60_000);

  it("a shim connecting with a matching PRISM_USER_ID is accepted", async () => {
    const dataDir = freshDataDir();

    const first = spawnShim(dataDir, dataDir, { PRISM_USER_ID: "alice" });
    spawnedShims.push(first);
    const firstClient: NdjsonClient = wrapNdjsonClient(first);
    firstClient.send(initializeRequest(1));
    const firstInit = await firstClient.waitFor(1, 20_000);
    expect(firstInit.result).toBeDefined();

    const second = spawnShim(dataDir, dataDir, { PRISM_USER_ID: "alice" });
    spawnedShims.push(second);
    const secondClient: NdjsonClient = wrapNdjsonClient(second);
    secondClient.send(initializeRequest(1));
    const secondInit = await secondClient.waitFor(1, 20_000);

    expect(secondInit.result).toBeDefined();
    expect(secondInit.error).toBeUndefined();
  }, 60_000);
});
