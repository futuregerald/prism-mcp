import { describe, it, expect, vi, beforeEach } from "vitest";

let mockHdcEnabled = false;

vi.mock("../../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    get PRISM_HDC_ENABLED() { return mockHdcEnabled; },
    PRISM_ACTR_ENABLED: false,
  };
});

vi.mock("../../src/storage/index.js", () => ({
  getStorage: vi.fn(),
}));

vi.mock("../../src/utils/llm/factory.js", () => ({
  getLLMProvider: vi.fn(() => ({
    generateEmbedding: vi.fn(async () => [0.1, 0.2, 0.3]),
    generateText: vi.fn(async () => ""),
  })),
}));

const { getStorage } = await import("../../src/storage/index.js");
const { sessionSearchMemoryHandler } = await import("../../src/tools/graphHandlers.js");

function row(id: string, similarity: number) {
  return {
    id,
    project: "dev",
    summary: `summary for ${id}`,
    similarity,
    session_date: "2026-09-24T00:00:00.000Z",
    created_at: "2026-09-24T00:00:00.000Z",
    decisions: [],
    files_changed: [],
    todos: [],
  };
}

function storageReturning(results: unknown[]) {
  const searchMemory = vi.fn(async () => results);
  return new Proxy({ searchMemory } as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === "then") return undefined;
      return vi.fn(async () => undefined);
    },
  });
}

const closeScores = [row("a", 0.66), row("b", 0.645), row("c", 0.6)];

describe("session_search_memory uncertainty rejection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getStorage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(storageReturning(closeScores));
  });

  it("returns results with close scores when HDC is off (the default)", async () => {
    mockHdcEnabled = false;
    const res: any = await sessionSearchMemoryHandler({ query: "prism memory footprint", project: "dev", similarity_threshold: 0.4 });
    const text = res.content.map((c: any) => c.text).join("\n");
    expect(res.isError).toBeFalsy();
    expect(text).not.toMatch(/Uncertainty Rejection/);
    expect(text).toMatch(/summary for a/);
  });

  it("still rejects close scores when HDC is on", async () => {
    mockHdcEnabled = true;
    const res: any = await sessionSearchMemoryHandler({ query: "prism memory footprint", project: "dev", similarity_threshold: 0.4 });
    const payload = JSON.parse(res.content[0].text);
    expect(payload.meta.rejected).toBe(true);
    expect(payload.results).toEqual([]);
  });
});
