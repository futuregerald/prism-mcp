/**
 * Storage readiness tracking, shared between stdio and daemon startup paths.
 *
 * The module-private flag/promise pair used to live inline in server.ts.
 * Both startServer() (stdio) and the daemon's main.ts now call startStorage()
 * so resource/prompt handlers see the same readiness signal in either mode.
 */

import { getStorage } from "./storage/index.js";

let storageReadyPromise: Promise<void> | null = null;
let storageIsReady = false;

export function isStorageReady(): boolean {
  return storageIsReady;
}

export function markStorageReady(): void {
  storageIsReady = true;
}

export function getStorageReadyPromise(): Promise<void> | null {
  return storageReadyPromise;
}

/**
 * Pre-warms the storage singleton, racing it against a timeout so callers
 * never block on a slow backend (e.g. Supabase REST init).
 */
export async function startStorage(): Promise<void> {
  const STORAGE_TIMEOUT_MS = 10_000;

  storageReadyPromise = Promise.race([
    getStorage().then(() => { markStorageReady(); }),
    new Promise<void>(resolve => setTimeout(() => {
      if (!isStorageReady()) {
        console.error(`[Prism] Storage pre-warm timed out after ${STORAGE_TIMEOUT_MS}ms (non-fatal)`);
      }
      resolve();
    }, STORAGE_TIMEOUT_MS)),
  ]).catch(err => {
    console.error(`[Prism] Storage pre-warm failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  });

  await storageReadyPromise;
}
