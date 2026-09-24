import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { checkExplicitSocketPath } from "../../src/utils/dataDir.js";

describe("checkExplicitSocketPath", () => {
  it("allows a socket path whose directory is owned by the current user and not group/world writable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-socket-ok-"));
    fs.chmodSync(dir, 0o700);

    const result = checkExplicitSocketPath(path.join(dir, "prismd.sock"));
    expect(result.ok).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a socket path whose directory is group-writable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-socket-groupw-"));
    fs.chmodSync(dir, 0o770);

    const result = checkExplicitSocketPath(path.join(dir, "prismd.sock"));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/writable/);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a socket path whose directory is world-writable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-socket-worldw-"));
    fs.chmodSync(dir, 0o702);

    const result = checkExplicitSocketPath(path.join(dir, "prismd.sock"));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/writable/);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a socket path whose directory does not exist", () => {
    const result = checkExplicitSocketPath("/no/such/dir/prismd.sock");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not accessible/);
  });
});
