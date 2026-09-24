import { describe, it, expect } from "vitest";
import { parsePositiveIntEnv } from "../../src/utils/envInt.js";

describe("parsePositiveIntEnv", () => {
  it("returns the default when the value is undefined", () => {
    expect(parsePositiveIntEnv(undefined, 42)).toBe(42);
  });

  it("parses a valid positive integer string", () => {
    expect(parsePositiveIntEnv("100", 42)).toBe(100);
  });

  it("allows zero", () => {
    expect(parsePositiveIntEnv("0", 42)).toBe(0);
  });

  it("falls back to the default for a non-numeric string", () => {
    expect(parsePositiveIntEnv("abc", 42)).toBe(42);
  });

  it("falls back to the default for a negative number", () => {
    expect(parsePositiveIntEnv("-5", 42)).toBe(42);
  });

  it("falls back to the default for an empty string", () => {
    expect(parsePositiveIntEnv("", 42)).toBe(42);
  });

  it("parses the leading integer portion, matching parseInt semantics", () => {
    expect(parsePositiveIntEnv("100ms", 42)).toBe(100);
  });
});
