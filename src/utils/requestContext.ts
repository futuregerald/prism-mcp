import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute } from "node:path";
import { safeCwd } from "./safeCwd.js";

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

export function clientWorkingDirectory(): string | undefined {
  const ctx = storage.getStore();
  if (typeof ctx?.cwd === "string" && isAbsolute(ctx.cwd)) return ctx.cwd;
  if (ctx?.clientId !== undefined) return undefined;
  return safeCwd();
}
