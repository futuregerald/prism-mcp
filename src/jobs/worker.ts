import { getStorage } from "../storage/index.js";
import { getSetting, setSetting } from "../storage/configStorage.js";
import { debugLog } from "../utils/logger.js";
import {
  findLedgerEntriesMissingEmbeddings,
  computeLedgerEmbeddingText,
  computeDirectSaveEmbeddingText,
  generateAndPatchLedgerEmbedding,
} from "../tools/hygieneHandlers.js";
import { runOutsideRequestContext } from "../utils/requestContext.js";
import { PRISM_USER_ID } from "../config.js";

type JobHandler = (payload: string) => Promise<void>;

const handlers = new Map<string, JobHandler>();

export function registerJobHandler(kind: string, handler: JobHandler): void {
  handlers.set(kind, handler);
}

interface EmbedLedgerJobPayload {
  entryId: string;
}

async function embedLedgerJobHandler(payloadJson: string): Promise<void> {
  const { entryId } = JSON.parse(payloadJson) as EmbedLedgerJobPayload;
  const storage = await getStorage();

  const rows = await storage.getLedgerEntries({
    id: `eq.${entryId}`,
    user_id: `eq.${PRISM_USER_ID}`,
    select: "id,summary,decisions,conversation_id,archived_at,deleted_at",
    limit: "1",
  });
  const row = rows[0] as any;
  if (!row || row.archived_at || row.deleted_at) {
    debugLog(`[JobWorker] embed_ledger: entry ${entryId} is gone or soft-deleted — skipping (job counted as complete)`);
    return;
  }

  const text = computeDirectSaveEmbeddingText(row);
  if (!text.trim()) {
    debugLog(`[JobWorker] embed_ledger: entry ${entryId} has no embeddable text — skipping (job counted as complete)`);
    return;
  }

  await generateAndPatchLedgerEmbedding(storage, entryId, text);
  debugLog(`[JobWorker] embed_ledger: embedding saved for entry ${entryId}`);
}

registerJobHandler("embed_ledger", embedLedgerJobHandler);

const RECOVERY_CURSOR_SETTING = "embed_recovery_cursor";
const RECOVERY_PAGE_SIZE = 200;
const RECOVERY_MAX_PAGES = 10;

async function readRecoveryCursor(): Promise<string | undefined> {
  try {
    return (await getSetting(RECOVERY_CURSOR_SETTING, "")) || undefined;
  } catch (err) {
    debugLog(`[JobWorker] Failed to read recovery cursor, starting from the beginning (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

async function writeRecoveryCursor(cursorId: string | undefined): Promise<void> {
  try {
    await setSetting(RECOVERY_CURSOR_SETTING, cursorId ?? "");
  } catch (err) {
    debugLog(`[JobWorker] Failed to persist recovery cursor (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function enqueueStartupRecoveryJobs(): Promise<void> {
  const storage = await getStorage();
  let cursorId: string | undefined = await readRecoveryCursor();
  let enqueued = 0;
  let wrapped = false;

  for (let page = 0; page < RECOVERY_MAX_PAGES && enqueued < RECOVERY_PAGE_SIZE; page++) {
    const entries = await findLedgerEntriesMissingEmbeddings(storage, {
      limit: RECOVERY_PAGE_SIZE,
      cursorId,
    });

    if (entries.length === 0) {
      if (wrapped) break;
      cursorId = undefined;
      wrapped = true;
      continue;
    }

    const candidateIds = entries.map((entry: any) => `embed_ledger:${entry.id}`);
    const existingJobIds = await storage.getExistingJobIds(candidateIds);

    for (const entry of entries) {
      const e = entry as any;
      cursorId = String(e.id);
      if (existingJobIds.has(`embed_ledger:${e.id}`)) continue;
      const text = computeLedgerEmbeddingText(e);
      if (!text.trim()) continue;
      await storage.enqueueJob(`embed_ledger:${e.id}`, "embed_ledger", JSON.stringify({ entryId: e.id }));
      enqueued++;
      if (enqueued >= RECOVERY_PAGE_SIZE) break;
    }
  }

  await writeRecoveryCursor(cursorId);
}

const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 5000;

async function processOneJob(): Promise<boolean> {
  const storage = await getStorage();
  const job = await storage.claimNextJob(Date.now(), LEASE_MS);
  if (!job) return false;

  const handler = handlers.get(job.kind);
  if (!handler) {
    const backoffMs = Math.pow(2, job.attempts) * BACKOFF_BASE_MS;
    await storage.failJob(job.id, `No handler registered for kind "${job.kind}"`, Date.now() + backoffMs);
    return true;
  }

  try {
    await handler(job.payload);
    await storage.deleteJob(job.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const backoffMs = Math.pow(2, job.attempts) * BACKOFF_BASE_MS;
    await storage.failJob(job.id, message, Date.now() + backoffMs);
    if (job.attempts >= MAX_ATTEMPTS) {
      debugLog(`[JobWorker] Job ${job.id} (${job.kind}) exhausted ${job.attempts} attempts, giving up: ${message}`);
    }
  }
  return true;
}

let stopped = true;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let processingLoop: Promise<void> | null = null;
let currentPollMs = 2000;

async function runPollCycle(): Promise<void> {
  let didWork = true;
  while (didWork && !stopped) {
    try {
      didWork = await processOneJob();
    } catch (err) {
      debugLog(`[JobWorker] Poll cycle failed (non-fatal, backing off): ${err instanceof Error ? err.message : String(err)}`);
      didWork = false;
    }
  }
}

function scheduleNextPoll(delayMs: number): void {
  if (stopped) return;
  runOutsideRequestContext(() => {
    pollTimer = setTimeout(() => {
      pollTimer = null;
      processingLoop = runPollCycle().finally(() => {
        processingLoop = null;
        scheduleNextPoll(currentPollMs);
      });
    }, delayMs);
  });
}

export interface StartJobWorkerOptions {
  pollMs?: number;
}

export async function startJobWorker(options: StartJobWorkerOptions = {}): Promise<void> {
  currentPollMs = options.pollMs ?? 2000;
  const storage = await getStorage();
  if (!storage.supportsJobQueue) {
    stopped = true;
    debugLog("[JobWorker] Storage backend has no durable job queue — skipping startup recovery sweep and polling");
    return;
  }
  stopped = false;
  const resetCount = await storage.resetDeadJobs();
  if (resetCount > 0) {
    debugLog(`[JobWorker] Reset ${resetCount} dead job(s) (attempts>=5) for one more cycle`);
  }
  await enqueueStartupRecoveryJobs();
  scheduleNextPoll(0);
}

export function kickJobWorker(): void {
  if (stopped) return;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (!processingLoop) {
    scheduleNextPoll(0);
  }
}

const STOP_WAIT_MS = 5000;

export async function stopJobWorker(waitMs: number = STOP_WAIT_MS): Promise<void> {
  stopped = true;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (processingLoop) {
    const timeout = new Promise<void>(resolve => {
      const timer = setTimeout(resolve, waitMs);
      timer.unref?.();
    });
    try {
      await Promise.race([processingLoop, timeout]);
    } catch (err) {
      debugLog(`[JobWorker] stopJobWorker: pending poll cycle rejected (ignored): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
