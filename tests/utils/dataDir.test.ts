import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, statSync, realpathSync, rmSync, mkdtempSync, mkdirSync, chmodSync, symlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "prism-datadir-fakehome-"));

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return {
    ...actual,
    homedir: () => FAKE_HOME,
  };
});

describe("getPrismDataDir", () => {
  const originalEnv = process.env.PRISM_DATA_DIR;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.PRISM_DATA_DIR;
    } else {
      process.env.PRISM_DATA_DIR = originalEnv;
    }
  });

  it("returns PRISM_DATA_DIR when set, without touching the home directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prism-datadir-override-"));
    process.env.PRISM_DATA_DIR = dir;

    const { getPrismDataDir } = await import("../../src/utils/dataDir.js");
    expect(getPrismDataDir()).toBe(dir);

    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the PRISM_DATA_DIR directory on first use with mode 0700", async () => {
    const base = mkdtempSync(join(tmpdir(), "prism-datadir-create-"));
    const nested = join(base, "nested", ".prism-mcp");
    process.env.PRISM_DATA_DIR = nested;

    const { getPrismDataDir } = await import("../../src/utils/dataDir.js");
    expect(existsSync(nested)).toBe(false);

    const result = getPrismDataDir();

    expect(result).toBe(nested);
    expect(existsSync(nested)).toBe(true);
    expect(statSync(nested).mode & 0o777).toBe(0o700);

    rmSync(base, { recursive: true, force: true });
  });

  it("falls back to homedir()/.prism-mcp when PRISM_DATA_DIR is unset", async () => {
    delete process.env.PRISM_DATA_DIR;

    const { getPrismDataDir } = await import("../../src/utils/dataDir.js");
    const result = getPrismDataDir();

    expect(result).toBe(join(FAKE_HOME, ".prism-mcp"));
    expect(existsSync(result)).toBe(true);
  });

  it("resolves the directory fresh on every call, not once at import time", async () => {
    const first = mkdtempSync(join(tmpdir(), "prism-datadir-first-"));
    const second = mkdtempSync(join(tmpdir(), "prism-datadir-second-"));

    const { getPrismDataDir } = await import("../../src/utils/dataDir.js");

    process.env.PRISM_DATA_DIR = first;
    expect(getPrismDataDir()).toBe(first);

    process.env.PRISM_DATA_DIR = second;
    expect(getPrismDataDir()).toBe(second);

    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  });

  it("tightens an existing data dir that has looser-than-0700 permissions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prism-datadir-loose-"));
    chmodSync(dir, 0o755);
    process.env.PRISM_DATA_DIR = dir;

    const { getPrismDataDir } = await import("../../src/utils/dataDir.js");
    const result = getPrismDataDir();

    expect(result).toBe(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);

    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves a symlinked data dir to its target and tightens the target's permissions", async () => {
    const base = mkdtempSync(join(tmpdir(), "prism-datadir-symlink-"));
    const real = join(base, "real");
    mkdirSync(real, { mode: 0o700 });
    chmodSync(real, 0o755);
    const link = join(base, "link");
    symlinkSync(real, link);
    process.env.PRISM_DATA_DIR = link;

    const { getPrismDataDir } = await import("../../src/utils/dataDir.js");
    const result = getPrismDataDir();

    expect(result).toBe(link);
    expect(statSync(realpathSync(link)).mode & 0o777).toBe(0o700);

    rmSync(base, { recursive: true, force: true });
  });

  it("refuses a resolved data dir that is not owned by the current user", async () => {
    const { isOwnedByCurrentUser } = await import("../../src/utils/dataDir.js");

    expect(isOwnedByCurrentUser(-1)).toBe(false);

    if (typeof process.getuid === "function") {
      expect(isOwnedByCurrentUser(process.getuid())).toBe(true);
    }
  });

  it("treats ownership as satisfied where process.getuid is unavailable", async () => {
    const processWithoutGetuid = process as { getuid?: () => number };
    const originalGetuid = processWithoutGetuid.getuid;
    delete processWithoutGetuid.getuid;

    const { isOwnedByCurrentUser } = await import("../../src/utils/dataDir.js");
    expect(isOwnedByCurrentUser(-1)).toBe(true);

    processWithoutGetuid.getuid = originalGetuid;
  });
});
