import { describe, it, expect } from "vitest";
import { makeLineSplitter, extractParseableId, MAX_LINE_BYTES } from "../../src/shim/lineSplitter.js";

describe("makeLineSplitter", () => {
  it("emits complete lines split across multiple chunks", () => {
    const lines: string[] = [];
    const splitter = makeLineSplitter(line => lines.push(line));

    splitter("hello ");
    splitter("world\nfoo");
    splitter("bar\nbaz\n");

    expect(lines).toEqual(["hello world", "foobar", "baz"]);
  });

  it("strips a trailing carriage return", () => {
    const lines: string[] = [];
    const splitter = makeLineSplitter(line => lines.push(line));
    splitter("hi\r\n");
    expect(lines).toEqual(["hi"]);
  });

  it("stays correct and fast across many small chunks with no newline until the end", () => {
    const lines: string[] = [];
    const splitter = makeLineSplitter(line => lines.push(line));

    const chunkCount = 20_000;
    const start = Date.now();
    for (let i = 0; i < chunkCount; i++) {
      splitter("x");
    }
    splitter("\n");
    const elapsedMs = Date.now() - start;

    expect(lines).toEqual(["x".repeat(chunkCount)]);
    expect(elapsedMs).toBeLessThan(3000);
  });

  it("invokes onOverflow with the discarded bytes once a single line exceeds the byte cap", () => {
    const lines: string[] = [];
    let overflowSize = 0;
    const splitter = makeLineSplitter(
      line => lines.push(line),
      discarded => { overflowSize = discarded.length; }
    );

    splitter(Buffer.alloc(MAX_LINE_BYTES + 1, "a"));
    expect(overflowSize).toBe(MAX_LINE_BYTES + 1);
    expect(lines).toEqual([]);

    splitter("recovered\n");
    expect(lines).toEqual(["recovered"]);
  });
});

describe("extractParseableId", () => {
  it("extracts a numeric id", () => {
    expect(extractParseableId('{"jsonrpc":"2.0","id":42,"method":"tools/call"')).toBe(42);
  });

  it("extracts a string id", () => {
    expect(extractParseableId('{"jsonrpc":"2.0","id":"abc-1","method":"tools/call"')).toBe("abc-1");
  });

  it("returns null when no id field is present", () => {
    expect(extractParseableId('{"jsonrpc":"2.0","method":"tools/call"')).toBeNull();
  });
});
