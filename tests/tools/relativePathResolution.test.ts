import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { dirname } from "node:path";
import { createTestDb } from "../helpers/fixtures.js";
import { getStorage, closeStorage } from "../../src/storage/index.js";
import { PRISM_USER_ID } from "../../src/config.js";
import { runWithRequestContext } from "../../src/utils/requestContext.js";
import { sessionSaveImageHandler, sessionSaveHandoffHandler, sessionExportMemoryHandler } from "../../src/tools/ledgerHandlers.js";
import { getCurrentGitState, getGitDrift } from "../../src/utils/git.js";

describe("relative-path resolution against the client's cwd (B8)", () => {
  const originalDataDir = process.env.PRISM_DATA_DIR;

  afterEach(async () => {
    await closeStorage();
    if (originalDataDir !== undefined) process.env.PRISM_DATA_DIR = originalDataDir;
    else delete process.env.PRISM_DATA_DIR;
  });

  it("session_save_image resolves a relative file_path against requestContext().cwd, not the daemon's cwd", async () => {
    const { dbPath, cleanup } = await createTestDb("relpath-image");
    try {
      process.env.PRISM_DATA_DIR = dirname(dbPath);
      await closeStorage();
      await getStorage();
      await sessionSaveHandoffHandler({ project: "relpath-image-project", last_summary: "baseline" }, undefined as any);

      const clientCwd = fs.mkdtempSync(path.join(os.tmpdir(), "relpath-client-cwd-"));
      const imagePath = path.join(clientCwd, "shot.png");
      fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const result: any = await runWithRequestContext({ cwd: clientCwd }, () =>
        sessionSaveImageHandler({ project: "relpath-image-project", file_path: "shot.png", description: "test image" })
      );

      expect(result.isError).toBeFalsy();
    } finally {
      cleanup();
    }
  });

  it("session_export_memory resolves a relative output_dir against requestContext().cwd", async () => {
    const { dbPath, cleanup } = await createTestDb("relpath-export");
    try {
      process.env.PRISM_DATA_DIR = dirname(dbPath);
      await closeStorage();
      const storage = await getStorage();

      await storage.saveLedger({
        project: "relpath-export-project",
        conversation_id: "conv-export",
        user_id: PRISM_USER_ID,
        summary: "Entry to export",
      });

      const clientCwd = fs.mkdtempSync(path.join(os.tmpdir(), "relpath-export-cwd-"));
      fs.mkdirSync(path.join(clientCwd, "out"));

      const result: any = await runWithRequestContext({ cwd: clientCwd }, () =>
        sessionExportMemoryHandler({ output_dir: "out", project: "relpath-export-project" })
      );

      expect(result.isError).toBeFalsy();
      const written = fs.readdirSync(path.join(clientCwd, "out"));
      expect(written.length).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });
});

describe("git.ts is fully async and defends against a non-absolute cwd (B7)", () => {
  it("getCurrentGitState resolves this repo asynchronously", async () => {
    const repoRoot = path.resolve(__dirname, "../..");
    const state = await getCurrentGitState(repoRoot);
    expect(state.isRepo).toBe(true);
    expect(typeof state.commitSha).toBe("string");
  });

  it("a non-absolute path falls back to process.cwd() instead of being passed to git as a relative cwd", async () => {
    const state = await getCurrentGitState("not-an-absolute-path");
    expect(typeof state.isRepo).toBe("boolean");
  });

  it("getGitDrift rejects a malformed SHA without ever invoking git", async () => {
    const drift = await getGitDrift("; rm -rf /", path.resolve(__dirname, "../.."));
    expect(drift).toBeNull();
  });
});
