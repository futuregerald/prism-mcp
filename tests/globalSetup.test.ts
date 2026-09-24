import { describe, it, expect, afterEach } from "vitest";
import { isWatchMode } from "./globalSetup.js";

describe("isWatchMode", () => {
  const originalArgv = [...process.argv];

  afterEach(() => {
    process.argv = [...originalArgv];
  });

  it("reads project.config.watch when present", () => {
    expect(isWatchMode({ config: { watch: true } })).toBe(true);
    expect(isWatchMode({ config: { watch: false } })).toBe(false);
  });

  it("falls back to project.vitest.config.watch", () => {
    expect(isWatchMode({ vitest: { config: { watch: true } } })).toBe(true);
  });

  it("falls back to process.argv when no project is passed", () => {
    process.argv = [...originalArgv, "--watch"];
    expect(isWatchMode(undefined)).toBe(true);

    process.argv = [...originalArgv];
    expect(isWatchMode(undefined)).toBe(false);
  });
});
