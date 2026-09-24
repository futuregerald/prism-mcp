import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  cwd?: string;
  clientId?: string;
  idempotencyKey?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function requestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function runOutsideRequestContext<T>(fn: () => T): T {
  return storage.exit(fn);
}
