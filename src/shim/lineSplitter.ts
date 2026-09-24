export const MAX_LINE_BYTES = 64 * 1024 * 1024;

export type LineSplitter = (chunk: Buffer | string) => void;

export function makeLineSplitter(onLine: (line: string) => void, onOverflow?: (discarded: Buffer) => void): LineSplitter {
  let buffered: Buffer = Buffer.alloc(0);
  let searchFrom = 0;

  return (chunk: Buffer | string) => {
    const chunkBuf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    buffered = buffered.length === 0 ? chunkBuf : Buffer.concat([buffered, chunkBuf]);

    for (; ;) {
      const idx = buffered.indexOf(0x0a, searchFrom);
      if (idx === -1) {
        searchFrom = buffered.length;
        if (buffered.length > MAX_LINE_BYTES) {
          const discarded = buffered;
          buffered = Buffer.alloc(0);
          searchFrom = 0;
          onOverflow?.(discarded);
        }
        return;
      }

      let end = idx;
      if (end > 0 && buffered[end - 1] === 0x0d) end -= 1;
      const line = buffered.subarray(0, end).toString("utf8");
      buffered = buffered.subarray(idx + 1);
      searchFrom = 0;
      onLine(line);
    }
  };
}

const ID_PATTERN = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?)/;

export function extractParseableId(oversizedChunk: string): string | number | null {
  const match = ID_PATTERN.exec(oversizedChunk);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}
