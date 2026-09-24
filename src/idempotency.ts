import { randomUUID, createHash } from "node:crypto";
import type { RequestLogRow } from "./storage/interface.js";
import { debugLog } from "./utils/logger.js";

const INSTANCE_ID = randomUUID();

export function getIdempotencyInstanceId(): string {
  return INSTANCE_ID;
}

export function resolveIdempotencyKey(rawKey: string | undefined, clientId: string | undefined): string | undefined {
  if (!rawKey || !clientId) return undefined;
  return rawKey.startsWith(`${clientId}:`) ? rawKey : undefined;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${parts.join(",")}}`;
}

export function computeArgsHash(toolName: string, args: unknown): string {
  return createHash("sha256").update(toolName).update(canonicalJson(args)).digest("hex");
}

function isToolErrorResult(result: unknown): boolean {
  return !!result && typeof result === "object" && (result as { isError?: unknown }).isError === true;
}

function idempotencyErrorResult(message: string): unknown {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

export interface IdempotencyStorage {
  getRequestLogRow(key: string): Promise<RequestLogRow | null>;
  insertPendingRequestLog(key: string, argsHash: string, owner: string): Promise<boolean>;
  completeRequestLog(key: string, response: string): Promise<void>;
  deleteRequestLog(key: string): Promise<void>;
  reclaimRequestLog(key: string, fromOwner: string, toOwner: string): Promise<boolean>;
}

const POLL_INTERVAL_MS = 100;
const POLL_MAX_MS = 30_000;
const SAME_OWNER_POLL_MAX_MS = 10 * 60 * 1000;
const NULL_ROW_RETRY_MAX = 300;

let pollMaxMsOverride: number | undefined;
let sameOwnerPollMaxMsOverride: number | undefined;

export function _setPollCapsForTest(pollMaxMs: number, sameOwnerPollMaxMs: number): void {
  pollMaxMsOverride = pollMaxMs;
  sameOwnerPollMaxMsOverride = sameOwnerPollMaxMs;
}

export function _resetPollCapsForTest(): void {
  pollMaxMsOverride = undefined;
  sameOwnerPollMaxMsOverride = undefined;
}

type PollOutcome =
  | { kind: "done"; response: string | null }
  | { kind: "gone" }
  | { kind: "timeout" };

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function pollUntilDone(storage: IdempotencyStorage, key: string, sameOwner: boolean): Promise<PollOutcome> {
  const capMs = sameOwner
    ? (sameOwnerPollMaxMsOverride ?? SAME_OWNER_POLL_MAX_MS)
    : (pollMaxMsOverride ?? POLL_MAX_MS);
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    const row = await storage.getRequestLogRow(key);
    if (!row) return { kind: "gone" };
    if (row.status === "done") return { kind: "done", response: row.response };
    await sleep(POLL_INTERVAL_MS);
  }
  return { kind: "timeout" };
}

export async function runIdempotent(
  storage: IdempotencyStorage,
  key: string,
  toolName: string,
  args: unknown,
  runTool: () => Promise<unknown>
): Promise<unknown> {
  const argsHash = computeArgsHash(toolName, args);
  const owner = getIdempotencyInstanceId();

  const runAndFinalize = async (): Promise<unknown> => {
    try {
      const result = await runTool();
      if (isToolErrorResult(result)) {
        await storage.deleteRequestLog(key);
      } else {
        await storage.completeRequestLog(key, JSON.stringify(result));
      }
      return result;
    } catch (err) {
      await storage.deleteRequestLog(key).catch(deleteErr => {
        debugLog(`[Idempotency] Failed to clean up pending row after tool error (non-fatal): ${deleteErr instanceof Error ? deleteErr.message : String(deleteErr)}`);
      });
      throw err;
    }
  };

  let nullRowRetries = 0;
  for (;;) {
    const inserted = await storage.insertPendingRequestLog(key, argsHash, owner);
    if (inserted) return runAndFinalize();

    const row = await storage.getRequestLogRow(key);
    if (!row) {
      nullRowRetries++;
      if (nullRowRetries > NULL_ROW_RETRY_MAX) {
        return idempotencyErrorResult("idempotency store is contended for this key, please retry");
      }
      await sleep(10);
      continue;
    }

    if (row.argsHash !== argsHash) {
      return idempotencyErrorResult("idempotency key reused with different arguments");
    }

    if (row.status === "done") {
      return JSON.parse(row.response ?? "null");
    }

    if (row.owner !== owner) {
      const reclaimed = await storage.reclaimRequestLog(key, row.owner, owner);
      if (reclaimed) return runAndFinalize();
    }

    const sameOwner = row.owner === owner;
    const outcome = await pollUntilDone(storage, key, sameOwner);
    if (outcome.kind === "done") return JSON.parse(outcome.response ?? "null");
    if (outcome.kind === "timeout") {
      return idempotencyErrorResult("request with this idempotency key is still in progress");
    }
  }
}
