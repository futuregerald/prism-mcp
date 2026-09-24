import { describe, it, expect } from "vitest";
import { MUTATING_TOOLS } from "../../src/tools/mutatingTools.js";
import { SHIM_MUTATING_TOOLS } from "../../src/shim/mutatingTools.js";

describe("shim mutating tools list matches the canonical list (R5)", () => {
  it("contains exactly the same tool names as src/tools/mutatingTools.ts", () => {
    expect([...SHIM_MUTATING_TOOLS].sort()).toEqual([...MUTATING_TOOLS].sort());
  });
});
