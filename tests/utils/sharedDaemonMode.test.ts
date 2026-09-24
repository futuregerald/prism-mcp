import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { shouldDelegateToSharedDaemon, SHARED_DAEMON_MARKER } from "../../src/utils/sharedDaemonMode.js";

describe("shouldDelegateToSharedDaemon", () => {
  let dataDir: string;
  let savedDataDir: string | undefined;
  let savedFlag: string | undefined;

  beforeEach(() => {
    savedDataDir = process.env.PRISM_DATA_DIR;
    savedFlag = process.env.PRISM_SHARED_DAEMON;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "psdm-"));
    process.env.PRISM_DATA_DIR = dataDir;
    delete process.env.PRISM_SHARED_DAEMON;
  });

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.PRISM_DATA_DIR; else process.env.PRISM_DATA_DIR = savedDataDir;
    if (savedFlag === undefined) delete process.env.PRISM_SHARED_DAEMON; else process.env.PRISM_SHARED_DAEMON = savedFlag;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const unixOnly = process.platform === "win32" ? it.skip : it;

  const writeMarker = () => fs.writeFileSync(path.join(dataDir, SHARED_DAEMON_MARKER), "");

  it("is off by default: no marker and no env", () => {
    expect(shouldDelegateToSharedDaemon()).toBe(false);
  });

  unixOnly("turns on when the marker file exists", () => {
    writeMarker();
    expect(shouldDelegateToSharedDaemon()).toBe(true);
  });

  for (const value of ["1", "true", "TRUE", "True"]) {
    unixOnly(`turns on with PRISM_SHARED_DAEMON=${value} and no marker`, () => {
      process.env.PRISM_SHARED_DAEMON = value;
      expect(shouldDelegateToSharedDaemon()).toBe(true);
    });
  }

  for (const value of ["0", "false", "FALSE", "False"]) {
    it(`PRISM_SHARED_DAEMON=${value} forces stdio even with the marker present`, () => {
      writeMarker();
      process.env.PRISM_SHARED_DAEMON = value;
      expect(shouldDelegateToSharedDaemon()).toBe(false);
    });
  }

  unixOnly("an unrecognised value falls back to the marker", () => {
    process.env.PRISM_SHARED_DAEMON = "maybe";
    expect(shouldDelegateToSharedDaemon()).toBe(false);
    writeMarker();
    expect(shouldDelegateToSharedDaemon()).toBe(true);
  });
});
