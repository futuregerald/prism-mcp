import { describe, it, expect, vi, afterEach } from "vitest";
import { safeCwd } from "../../src/utils/safeCwd.js";
import { getCurrentGitState, getGitDrift } from "../../src/utils/git.js";
import { ShimSession } from "../../src/shim/session.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const throwLikeDeletedCwd = () => {
  vi.spyOn(process, "cwd").mockImplementation(() => {
    throw Object.assign(new Error("ENOENT: process.cwd failed"), { code: "ENOENT" });
  });
};

describe("safeCwd", () => {
  it("returns the working directory normally", () => {
    expect(safeCwd()).toBe(process.cwd());
  });

  it("returns undefined when the working directory was removed", () => {
    throwLikeDeletedCwd();
    expect(safeCwd()).toBeUndefined();
  });
});

describe("git helpers with a removed working directory", () => {
  it("getCurrentGitState reports no repo instead of throwing", async () => {
    throwLikeDeletedCwd();
    await expect(getCurrentGitState()).resolves.toEqual({ isRepo: false, branch: null, commitSha: null });
  });

  it("getGitDrift reports no drift instead of throwing", async () => {
    throwLikeDeletedCwd();
    await expect(getGitDrift("abcdef1")).resolves.toBeNull();
  });
});

describe("ShimSession hello without a working directory", () => {
  it("leaves cwd out of the hello", () => {
    const session = new ShimSession({ clientId: "c1", cwd: undefined, mutatingTools: [], requestTimeoutMs: 1000 });
    const hello = JSON.parse(session.onConnected()[0].line);
    expect(hello).toEqual({ prism_hello: { v: 1, clientId: "c1" } });
  });
});
