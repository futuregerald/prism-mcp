export type ShimActionTarget = "daemon" | "client";

export interface ShimAction {
  to: ShimActionTarget;
  line: string;
}

export interface ShimSessionOptions {
  clientId: string;
  cwd: string;
  mutatingTools: readonly string[];
  requestTimeoutMs: number;
}

interface InFlightEntry {
  line: string;
}

const REINIT_ID_PREFIX = "prism-shim-reinit-";

function tryParseJson(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

export class ShimSession {
  private readonly clientId: string;
  private readonly cwd: string;
  private readonly mutatingTools: Set<string>;
  private readonly requestTimeoutMs: number;

  private connected = false;
  private disconnectedAt: number | null = null;
  private initializeRequestRaw: string | null = null;
  private initializedSeen = false;
  private reinitCounter = 0;
  private readonly inFlight = new Map<string, InFlightEntry>();
  private queue: string[] = [];

  constructor(options: ShimSessionOptions) {
    this.clientId = options.clientId;
    this.cwd = options.cwd;
    this.mutatingTools = new Set(options.mutatingTools);
    this.requestTimeoutMs = options.requestTimeoutMs;
  }

  onClientLine(rawLine: string, nowMs: number): ShimAction[] {
    const parsed = tryParseJson(rawLine);
    if (parsed === undefined || parsed === null || typeof parsed !== "object") {
      return this.forwardOrQueue(rawLine);
    }

    const hasId = Object.prototype.hasOwnProperty.call(parsed, "id") && parsed.id !== undefined;
    const method = typeof parsed.method === "string" ? parsed.method : undefined;

    if (hasId && method === "initialize") {
      this.initializeRequestRaw = rawLine;
    }

    if (!hasId && method === "notifications/initialized") {
      const alreadySeen = this.initializedSeen;
      this.initializedSeen = true;
      if (!this.connected && alreadySeen) {
        return [];
      }
      return this.forwardOrQueue(rawLine);
    }

    if (hasId) {
      let line = rawLine;
      if (method === "tools/call" && parsed.params && this.mutatingTools.has(parsed.params.name)) {
        const meta = { ...(parsed.params._meta || {}), "prism/idempotencyKey": `${this.clientId}:${String(parsed.id)}` };
        const withMeta = { ...parsed, params: { ...parsed.params, _meta: meta } };
        line = JSON.stringify(withMeta);
      }
      const key = JSON.stringify(parsed.id);
      this.inFlight.set(key, { line });
      if (this.connected) {
        return [{ to: "daemon", line }];
      }
      return [];
    }

    return this.forwardOrQueue(rawLine);
  }

  private forwardOrQueue(rawLine: string): ShimAction[] {
    if (this.connected) {
      return [{ to: "daemon", line: rawLine }];
    }
    this.queue.push(rawLine);
    return [];
  }

  onDaemonLine(rawLine: string): ShimAction[] {
    const parsed = tryParseJson(rawLine);
    if (parsed === undefined || parsed === null || typeof parsed !== "object") {
      return [{ to: "client", line: rawLine }];
    }

    const hasId = Object.prototype.hasOwnProperty.call(parsed, "id") && parsed.id !== undefined;
    if (hasId) {
      if (typeof parsed.id === "string" && parsed.id.startsWith(REINIT_ID_PREFIX)) {
        return [];
      }
      this.inFlight.delete(JSON.stringify(parsed.id));
    }

    return [{ to: "client", line: rawLine }];
  }

  onConnected(): ShimAction[] {
    this.connected = true;
    this.disconnectedAt = null;

    const actions: ShimAction[] = [];
    actions.push({
      to: "daemon",
      line: JSON.stringify({ prism_hello: { v: 1, cwd: this.cwd, clientId: this.clientId } }),
    });

    if (this.initializedSeen && this.initializeRequestRaw !== null) {
      this.reinitCounter += 1;
      const reinitId = `${REINIT_ID_PREFIX}${this.reinitCounter}`;
      const parsedInit = tryParseJson(this.initializeRequestRaw);
      const reinitLine = parsedInit !== undefined
        ? JSON.stringify({ ...parsedInit, id: reinitId })
        : this.initializeRequestRaw;
      actions.push({ to: "daemon", line: reinitLine });
      actions.push({ to: "daemon", line: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    }

    for (const entry of this.inFlight.values()) {
      actions.push({ to: "daemon", line: entry.line });
    }

    for (const queuedLine of this.queue) {
      actions.push({ to: "daemon", line: queuedLine });
    }
    this.queue = [];

    return actions;
  }

  onDisconnected(nowMs: number): ShimAction[] {
    this.connected = false;
    this.disconnectedAt = nowMs;
    return [];
  }

  checkTimeouts(nowMs: number): ShimAction[] {
    if (this.connected || this.disconnectedAt === null) return [];
    if (nowMs - this.disconnectedAt < this.requestTimeoutMs) return [];

    const actions: ShimAction[] = [];
    for (const key of this.inFlight.keys()) {
      const id = JSON.parse(key);
      actions.push({
        to: "client",
        line: JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: "prism daemon unavailable" },
        }),
      });
    }
    this.inFlight.clear();
    return actions;
  }
}
