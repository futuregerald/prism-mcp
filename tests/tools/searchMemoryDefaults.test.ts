import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/storage/index.js", () => ({
  getStorage: vi.fn(),
}));

const generateEmbedding = vi.fn(async () => [0.1, 0.2, 0.3]);
let recommended: number | undefined;

vi.mock("../../src/utils/llm/factory.js", () => ({
  getLLMProvider: vi.fn(() => ({
    generateEmbedding,
    generateText: vi.fn(async () => ""),
    get recommendedSimilarityThreshold() { return recommended; },
  })),
}));

const { getStorage } = await import("../../src/storage/index.js");
const { sessionSearchMemoryHandler } = await import("../../src/tools/graphHandlers.js");

const searchMemory = vi.fn(async () => []);

describe("session_search_memory defaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getStorage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Proxy({ searchMemory } as Record<string | symbol, unknown>, {
        get(target, prop) {
          if (prop in target) return target[prop];
          if (prop === "then") return undefined;
          return vi.fn(async () => undefined);
        },
      })
    );
  });

  const thresholdSentToStorage = () => (searchMemory.mock.calls[0] as unknown as [{ similarityThreshold: number }])[0].similarityThreshold;

  it("uses the provider's recommended threshold when the caller omits one", async () => {
    recommended = 0.5;
    const res: any = await sessionSearchMemoryHandler({ query: "why is memory high", project: "dev" });
    expect(thresholdSentToStorage()).toBe(0.5);
    expect(res.content[0].text).toMatch(/Similarity threshold: 0\.5/);
  });

  it("falls back to 0.7 when the provider recommends nothing", async () => {
    recommended = undefined;
    await sessionSearchMemoryHandler({ query: "why is memory high", project: "dev" });
    expect(thresholdSentToStorage()).toBe(0.7);
  });

  it("an explicit similarity_threshold always wins", async () => {
    recommended = 0.5;
    await sessionSearchMemoryHandler({ query: "why is memory high", project: "dev", similarity_threshold: 0.8 });
    expect(thresholdSentToStorage()).toBe(0.8);
  });

  it("embeds the search text as a query", async () => {
    recommended = 0.5;
    await sessionSearchMemoryHandler({ query: "why is memory high", project: "dev" });
    expect(generateEmbedding).toHaveBeenCalledWith(expect.any(String), "query");
  });
});
