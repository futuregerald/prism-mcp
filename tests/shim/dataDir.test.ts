import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("shim getPrismDataDir hardening", () => {
  const originalEnv = process.env.PRISM_DATA_DIR;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PRISM_DATA_DIR;
    else process.env.PRISM_DATA_DIR = originalEnv;
  });

  it("tightens an existing data dir that has looser-than-0700 permissions", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-shim-datadir-loose-"));
    fs.chmodSync(dir, 0o755);
    process.env.PRISM_DATA_DIR = dir;

    const { getPrismDataDir } = await import("../../src/shim/dataDir.js");
    const result = getPrismDataDir();

    expect(result).toBe(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("resolves a symlinked data dir to its target", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "prism-shim-datadir-symlink-"));
    const real = path.join(base, "real");
    fs.mkdirSync(real, { mode: 0o700 });
    const link = path.join(base, "link");
    fs.symlinkSync(real, link);
    process.env.PRISM_DATA_DIR = link;

    const { getPrismDataDir } = await import("../../src/shim/dataDir.js");
    const result = getPrismDataDir();

    expect(result).toBe(link);
    expect(fs.statSync(fs.realpathSync(link)).mode & 0o777).toBe(0o700);

    fs.rmSync(base, { recursive: true, force: true });
  });
});

describe("openDaemonLogFd", () => {
  it("opens the log file with mode 0600 and appends without truncating", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-shim-log-"));
    const logPath = path.join(dir, "prismd.log");
    fs.writeFileSync(logPath, "existing\n");

    const { openDaemonLogFd } = await import("../../src/shim/dataDir.js");
    const fd = openDaemonLogFd(logPath);
    fs.writeSync(fd, "appended\n");
    fs.closeSync(fd);

    const contents = fs.readFileSync(logPath, "utf8");
    expect(contents).toBe("existing\nappended\n");
    expect(fs.statSync(logPath).mode & 0o777).toBe(0o600);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rotates the log to .1 once it exceeds 10MB", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-shim-log-rotate-"));
    const logPath = path.join(dir, "prismd.log");
    fs.writeFileSync(logPath, Buffer.alloc(10 * 1024 * 1024 + 1, "a"));

    const { openDaemonLogFd } = await import("../../src/shim/dataDir.js");
    const fd = openDaemonLogFd(logPath);
    fs.writeSync(fd, "fresh\n");
    fs.closeSync(fd);

    expect(fs.existsSync(`${logPath}.1`)).toBe(true);
    expect(fs.readFileSync(logPath, "utf8")).toBe("fresh\n");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses to follow a symlink at the log path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-shim-log-symlink-"));
    const real = path.join(dir, "real.log");
    fs.writeFileSync(real, "");
    const link = path.join(dir, "prismd.log");
    fs.symlinkSync(real, link);

    const { openDaemonLogFd } = await import("../../src/shim/dataDir.js");
    expect(() => openDaemonLogFd(link)).toThrow();

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
