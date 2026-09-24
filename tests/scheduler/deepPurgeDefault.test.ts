import { describe, it, expect, vi, afterEach } from "vitest";

describe("DeepPurge is off unless PRISM_DEEP_PURGE_ENABLED=true", () => {
  const saved = process.env.PRISM_DEEP_PURGE_ENABLED;

  afterEach(() => {
    if (saved === undefined) delete process.env.PRISM_DEEP_PURGE_ENABLED; else process.env.PRISM_DEEP_PURGE_ENABLED = saved;
    vi.resetModules();
  });

  it("is disabled in the default scheduler config", async () => {
    delete process.env.PRISM_DEEP_PURGE_ENABLED;
    vi.resetModules();
    const { DEFAULT_SCHEDULER_CONFIG } = await import("../../src/backgroundScheduler.js");
    expect(DEFAULT_SCHEDULER_CONFIG.enableDeepPurge).toBe(false);
  }, 60_000);

  it("is enabled when PRISM_DEEP_PURGE_ENABLED=true", async () => {
    process.env.PRISM_DEEP_PURGE_ENABLED = "true";
    vi.resetModules();
    const { DEFAULT_SCHEDULER_CONFIG } = await import("../../src/backgroundScheduler.js");
    expect(DEFAULT_SCHEDULER_CONFIG.enableDeepPurge).toBe(true);
  }, 60_000);
});
