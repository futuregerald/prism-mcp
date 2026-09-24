import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { runWithRequestContext, requestContext } from "../../src/utils/requestContext.js";
import { getCurrentGitState } from "../../src/utils/git.js";

describe("requestContext", () => {
  it("returns undefined outside any runWithRequestContext call", () => {
    expect(requestContext()).toBeUndefined();
  });

  it("makes the context visible inside the callback, including across an await", async () => {
    await runWithRequestContext({ cwd: "/tmp/project-x", clientId: "client-x" }, async () => {
      expect(requestContext()).toEqual({ cwd: "/tmp/project-x", clientId: "client-x" });
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(requestContext()).toEqual({ cwd: "/tmp/project-x", clientId: "client-x" });
    });
  });

  it("does not leak between sibling calls", async () => {
    const seen: Array<string | undefined> = [];
    await Promise.all([
      runWithRequestContext({ cwd: "/tmp/a" }, async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        seen.push(requestContext()?.cwd);
      }),
      runWithRequestContext({ cwd: "/tmp/b" }, async () => {
        await new Promise(resolve => setTimeout(resolve, 1));
        seen.push(requestContext()?.cwd);
      }),
    ]);
    expect(seen.sort()).toEqual(["/tmp/a", "/tmp/b"]);
  });

  it("getCurrentGitState() defaults to requestContext().cwd when no explicit path is passed", async () => {
    const repoRoot = path.resolve(__dirname, "../..");

    const outsideContext = await getCurrentGitState("/dev/null/not-a-repo");
    expect(outsideContext.isRepo).toBe(false);

    await runWithRequestContext({ cwd: repoRoot }, async () => {
      const state = await getCurrentGitState();
      expect(state.isRepo).toBe(true);
    });
  });

  it("getCurrentGitState() falls back to process.cwd() when no request context is active", async () => {
    const state = await getCurrentGitState();
    expect(typeof state.isRepo).toBe("boolean");
  });
});
