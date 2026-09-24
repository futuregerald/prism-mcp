import { getStorage } from "../storage/index.js";
import { debugLog } from "../utils/logger.js";
import { getLLMProvider } from "../utils/llm/factory.js";
import { findLedgerEntriesMissingEmbeddings, computeLedgerEmbeddingText } from "../tools/hygieneHandlers.js";

type JobHandler = (payload: string) => Promise<void>;

const handlers = new Map<string, JobHandler>();

export function registerJobHandler(kind: string, handler: JobHandler): void {
  handlers.set(kind, handler);
}

interface EmbedLedgerJobPayload {
  entryId: string;
  text: string;
}

async function embedLedgerJobHandler(payloadJson: string): Promise<void> {
  const { entryId, text } = JSON.parse(payloadJson) as EmbedLedgerJobPayload;
  const storage = await getStorage();
  const embedding = await getLLMProvider().generateEmbedding(text);

  const patchData: Record<string, unknown> = {
    embedding: JSON.stringify(embedding),
  };

  try {
    const { getDefaultCompressor, serialize } = await import("../utils/turboquant.js");
    const compressor = getDefaultCompressor();
    const compressed = compressor.compress(embedding);
    const buf = serialize(compressed);

    patchData.embedding_compressed = buf.toString("base64");
    patchData.embedding_format = `turbo${compressor.bits}`;
    patchData.embedding_turbo_radius = compressed.radius;
    debugLog(`[JobWorker] embed_ledger: TurboQuant compressed ${buf.length} bytes for entry ${entryId}`);
  } catch (turboErr: any) {
    console.error(`[JobWorker] embed_ledger: TurboQuant compression failed for entry ${entryId} (non-fatal): ${turboErr.message}`);
  }

  await storage.patchLedger(entryId, patchData);
  debugLog(`[JobWorker] embed_ledger: embedding saved for entry ${entryId}`);
}

registerJobHandler("embed_ledger", embedLedgerJobHandler);

async function enqueueStartupRecoveryJobs(): Promise<void> {
  const storage = await getStorage();
  const entries = await findLedgerEntriesMissingEmbeddings(storage, { limit: 200 });
  for (const entry of entries) {
    const e = entry as any;
    const text = computeLedgerEmbeddingText(e);
    if (!text.trim()) continue;
    await storage.enqueueJob(`embed_ledger:${e.id}`, "embed_ledger", JSON.stringify({ entryId: e.id, text }));
  }
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
    await storage.completeJob(job.id);
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
    didWork = await processOneJob();
  }
}

function scheduleNextPoll(delayMs: number): void {
  if (stopped) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    processingLoop = runPollCycle().finally(() => {
      processingLoop = null;
      scheduleNextPoll(currentPollMs);
    });
  }, delayMs);
}

export interface StartJobWorkerOptions {
  pollMs?: number;
}

export async function startJobWorker(options: StartJobWorkerOptions = {}): Promise<void> {
  currentPollMs = options.pollMs ?? 2000;
  stopped = false;
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

export async function stopJobWorker(): Promise<void> {
  stopped = true;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (processingLoop) {
    await processingLoop;
  }
}
