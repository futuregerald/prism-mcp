import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";

import { isPrismServerProcess } from "../src/lifecycle.js";

describe("isPrismServerProcess", () => {
  const spawned: ChildProcess[] = [];

  afterEach(() => {
    for (const child of spawned.splice(0)) {
      try { child.kill("SIGKILL"); } catch { }
    }
  });

  function spawnDummy(fakeScriptPath: string): ChildProcess {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)", "--", fakeScriptPath], {
      stdio: "ignore",
    });
    spawned.push(child);
    return child;
  }

  it("returns false for a process whose command is not a Prism server", async () => {
    const child = spawnDummy("not-a-prism-server.js");
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(isPrismServerProcess(child.pid!)).toBe(false);
  });

  it("returns true for a process whose command contains dist/server.js", async () => {
    const child = spawnDummy("/some/path/dist/server.js");
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(isPrismServerProcess(child.pid!)).toBe(true);
  });

  it("returns false once the process has exited", async () => {
    const child = spawnDummy("dist/server.js");
    await new Promise(resolve => setTimeout(resolve, 100));
    child.kill("SIGKILL");
    await new Promise(resolve => child.once("exit", resolve));
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(isPrismServerProcess(child.pid!)).toBe(false);
  });
});
