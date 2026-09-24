import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { shouldDelegateToSharedDaemon, SHARED_DAEMON_MARKER } from "../../src/utils/sharedDaemonMode.js";
import { resolveProjectMediaDir } from "../../src/utils/dataDir.js";
import { computeConfigFingerprint } from "../../src/utils/configFingerprint.js";

let dataDir: string;
let savedDataDir: string | undefined;
let savedFlag: string | undefined;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

beforeEach(() => {
  savedDataDir = process.env.PRISM_DATA_DIR;
  savedFlag = process.env.PRISM_SHARED_DAEMON;
  dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "plh-")));
  process.env.PRISM_DATA_DIR = dataDir;
  delete process.env.PRISM_SHARED_DAEMON;
});

afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  if (savedDataDir === undefined) delete process.env.PRISM_DATA_DIR; else process.env.PRISM_DATA_DIR = savedDataDir;
  if (savedFlag === undefined) delete process.env.PRISM_SHARED_DAEMON; else process.env.PRISM_SHARED_DAEMON = savedFlag;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const unixOnly = process.platform === "win32" ? it.skip : it;

describe("shared-daemon marker must be a regular file", () => {
  it("ignores a directory named like the marker", () => {
    fs.mkdirSync(path.join(dataDir, SHARED_DAEMON_MARKER));
    expect(shouldDelegateToSharedDaemon()).toBe(false);
  });

  unixOnly("ignores a symlink named like the marker", () => {
    const target = path.join(dataDir, "elsewhere");
    fs.writeFileSync(target, "");
    fs.symlinkSync(target, path.join(dataDir, SHARED_DAEMON_MARKER));
    expect(shouldDelegateToSharedDaemon()).toBe(false);
  });

  unixOnly("accepts a regular file", () => {
    fs.writeFileSync(path.join(dataDir, SHARED_DAEMON_MARKER), "");
    expect(shouldDelegateToSharedDaemon()).toBe(true);
  });
});

describe("shared-daemon mode is Unix-only", () => {
  it("never delegates on win32, even with the marker and PRISM_SHARED_DAEMON=true", () => {
    fs.writeFileSync(path.join(dataDir, SHARED_DAEMON_MARKER), "");
    process.env.PRISM_SHARED_DAEMON = "true";
    Object.defineProperty(process, "platform", { value: "win32" });
    expect(shouldDelegateToSharedDaemon()).toBe(false);
  });
});

describe("resolveProjectMediaDir", () => {
  it("keeps an ordinary project inside media/", () => {
    expect(resolveProjectMediaDir("dev")).toBe(path.join(dataDir, "media", "dev"));
  });

  for (const bad of ["../shared-daemon", "..", "../../etc", "/tmp/evil", "a/../../x", ""]) {
    it(`refuses project ${JSON.stringify(bad)}`, () => {
      expect(() => resolveProjectMediaDir(bad)).toThrow(/media directory/);
    });
  }
});

describe("computeConfigFingerprint covers every setting that picks the backend or its credentials", () => {
  const base = { PRISM_USER_ID: "u", PRISM_STORAGE: "supabase", SUPABASE_URL: "https://x" };
  for (const key of ["SUPABASE_KEY", "PRISM_STORAGE_BACKEND", "PRISM_JWT_ISSUER", "PRISM_JWT_AUDIENCE", "SUPABASE_ANON_KEY", "PRISM_DASHBOARD_USER", "PRISM_DASHBOARD_PASS", "PRISM_INSTANCE"]) {
    it(`changes when ${key} changes`, () => {
      expect(computeConfigFingerprint({ ...base, [key]: "a" })).not.toBe(computeConfigFingerprint({ ...base, [key]: "b" }));
    });
  }

  it("is stable for identical settings", () => {
    expect(computeConfigFingerprint({ ...base })).toBe(computeConfigFingerprint({ ...base }));
  });
});
