import { getStorage } from "./storage/index.js";
import { debugLog } from "./utils/logger.js";

export const REQUEST_LOG_RETENTION_MS = 10 * 60 * 1000;
export const REQUEST_LOG_SWEEP_INTERVAL_MS = 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;

async function sweepOnce(): Promise<void> {
  try {
    const storage = await getStorage();
    await storage.pruneRequestLog(REQUEST_LOG_RETENTION_MS);
  } catch (err) {
    debugLog(`[RequestLogRetention] Sweep failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function startRequestLogRetention(intervalMs: number = REQUEST_LOG_SWEEP_INTERVAL_MS): void {
  if (timer) return;
  timer = setInterval(() => { void sweepOnce(); }, intervalMs);
  timer.unref();
}

export function stopRequestLogRetention(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
