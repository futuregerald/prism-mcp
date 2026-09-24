import { describe, it, expect } from "vitest";
import { ShimSession, type ShimAction } from "../../src/shim/session.js";

const MUTATING = ["session_save_ledger", "session_save_handoff"];

function newSession(overrides: Partial<{ clientId: string; cwd: string; requestTimeoutMs: number }> = {}) {
  return new ShimSession({
    clientId: overrides.clientId ?? "client-1",
    cwd: overrides.cwd ?? "/proj",
    mutatingTools: MUTATING,
    requestTimeoutMs: overrides.requestTimeoutMs ?? 1000,
  });
}

function toDaemon(actions: ShimAction[]): string[] {
  return actions.filter(a => a.to === "daemon").map(a => a.line);
}

function toClient(actions: ShimAction[]): string[] {
  return actions.filter(a => a.to === "client").map(a => a.line);
}

function req(id: number | string, method: string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function notif(method: string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: "2.0", method, params });
}

function resp(id: number | string, result: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

describe("ShimSession — idempotency key injection", () => {
  it("injects the key only for tools in the mutating list", () => {
    const session = newSession({ clientId: "abc" });
    session.onConnected();

    const mutatingLine = req(1, "tools/call", { name: "session_save_ledger", arguments: { x: 1 } });
    const [mutatingAction] = toDaemon(session.onClientLine(mutatingLine, 0));
    const mutatingParsed = JSON.parse(mutatingAction);
    expect(mutatingParsed.params._meta["prism/idempotencyKey"]).toBe("abc:1");
    expect(mutatingParsed.params.arguments).toEqual({ x: 1 });

    const readLine = req(2, "tools/call", { name: "session_load_context", arguments: { x: 1 } });
    const [readAction] = toDaemon(session.onClientLine(readLine, 0));
    const readParsed = JSON.parse(readAction);
    expect(readParsed.params._meta).toBeUndefined();
  });

  it("preserves existing _meta fields when injecting", () => {
    const session = newSession({ clientId: "abc" });
    session.onConnected();

    const line = req(5, "tools/call", { name: "session_save_ledger", arguments: {}, _meta: { other: "keep-me" } });
    const [action] = toDaemon(session.onClientLine(line, 0));
    const parsed = JSON.parse(action);
    expect(parsed.params._meta.other).toBe("keep-me");
    expect(parsed.params._meta["prism/idempotencyKey"]).toBe("abc:5");
  });
});

describe("ShimSession — reconnect replay", () => {
  it("does not replay initialize if the client never initialized", () => {
    const session = newSession();
    const actions = session.onConnected();
    expect(actions).toEqual([
      { to: "daemon", line: JSON.stringify({ prism_hello: { v: 1, cwd: "/proj", clientId: "client-1" } }) },
    ]);
  });

  it("replays initialize + notifications/initialized only after the client has fully initialized once, in the documented order", () => {
    const session = newSession({ clientId: "c1", cwd: "/proj" });

    session.onConnected();

    const initLine = req(1, "initialize", { protocolVersion: "2025-06-18" });
    expect(toDaemon(session.onClientLine(initLine, 0))).toEqual([initLine]);

    const initializedLine = notif("notifications/initialized");
    expect(toDaemon(session.onClientLine(initializedLine, 0))).toEqual([initializedLine]);

    expect(session.onDaemonLine(resp(1, { serverInfo: {} }))).toEqual([
      { to: "client", line: resp(1, { serverInfo: {} }) },
    ]);

    const fooLine = req(2, "tools/call", { name: "session_load_context" });
    expect(toDaemon(session.onClientLine(fooLine, 0))).toEqual([fooLine]);

    session.onDisconnected(100);

    const progressLine = notif("notifications/progress", { pct: 50 });
    expect(session.onClientLine(progressLine, 150)).toEqual([]);

    const mutatingLine = req(3, "tools/call", { name: "session_save_ledger", arguments: {} });
    expect(session.onClientLine(mutatingLine, 150)).toEqual([]);

    const reconnectActions = toDaemon(session.onConnected());

    expect(reconnectActions[0]).toBe(JSON.stringify({ prism_hello: { v: 1, cwd: "/proj", clientId: "c1" } }));

    const replayedInit = JSON.parse(reconnectActions[1]);
    expect(replayedInit.id).toBe("prism-shim-reinit-1");
    expect(replayedInit.method).toBe("initialize");
    expect(replayedInit.params).toEqual({ protocolVersion: "2025-06-18" });

    expect(JSON.parse(reconnectActions[2])).toEqual({ jsonrpc: "2.0", method: "notifications/initialized" });

    const replayedFoo = JSON.parse(reconnectActions[3]);
    expect(replayedFoo.id).toBe(2);
    expect(replayedFoo.method).toBe("tools/call");

    const replayedMutating = JSON.parse(reconnectActions[4]);
    expect(replayedMutating.id).toBe(3);
    expect(replayedMutating.params._meta["prism/idempotencyKey"]).toBe("c1:3");

    expect(reconnectActions[5]).toBe(progressLine);
    expect(reconnectActions.length).toBe(6);
  });

  it("swallows a daemon response whose id starts with prism-shim-reinit-", () => {
    const session = newSession();
    session.onConnected();
    session.onClientLine(req(1, "initialize", {}), 0);
    session.onClientLine(notif("notifications/initialized"), 0);
    session.onDaemonLine(resp(1, {}));
    session.onDisconnected(0);
    session.onConnected();

    const swallowed = session.onDaemonLine(resp("prism-shim-reinit-1", { serverInfo: {} }));
    expect(swallowed).toEqual([]);
  });
});

describe("ShimSession — in-flight tracking", () => {
  it("removes an in-flight request once its response arrives, so it is not replayed", () => {
    const session = newSession();
    session.onConnected();

    const line = req(9, "tools/call", { name: "session_load_context" });
    session.onClientLine(line, 0);
    session.onDaemonLine(resp(9, {}));

    session.onDisconnected(0);
    const reconnectActions = session.onConnected();
    expect(reconnectActions).toEqual([
      { to: "daemon", line: JSON.stringify({ prism_hello: { v: 1, cwd: "/proj", clientId: "client-1" } }) },
    ]);
  });

  it("flushes queued notification lines after in-flight replays, in original order", () => {
    const session = newSession();
    session.onConnected();
    session.onDisconnected(0);

    session.onClientLine(notif("notifications/progress", { a: 1 }), 0);
    session.onClientLine(notif("notifications/progress", { a: 2 }), 0);
    const inFlightLine = req(1, "tools/call", { name: "session_load_context" });
    session.onClientLine(inFlightLine, 0);
    session.onClientLine(notif("notifications/progress", { a: 3 }), 0);

    const actions = toDaemon(session.onConnected());
    expect(actions).toEqual([
      JSON.stringify({ prism_hello: { v: 1, cwd: "/proj", clientId: "client-1" } }),
      inFlightLine,
      notif("notifications/progress", { a: 1 }),
      notif("notifications/progress", { a: 2 }),
      notif("notifications/progress", { a: 3 }),
    ]);
  });

  it("handles both numeric and string ids without collision", () => {
    const session = newSession();
    session.onConnected();

    session.onClientLine(req(1, "tools/call", { name: "session_load_context" }), 0);
    session.onClientLine(req("1", "tools/call", { name: "session_load_context" }), 0);

    session.onDaemonLine(resp(1, { ok: "numeric" }));
    session.onDisconnected(0);

    const actions = toDaemon(session.onConnected());
    expect(actions.length).toBe(2);
    const replayed = JSON.parse(actions[1]);
    expect(replayed.id).toBe("1");
  });
});

describe("ShimSession — timeouts", () => {
  it("emits a JSON-RPC error and drops the request once the disconnect exceeds the timeout", () => {
    const session = newSession({ requestTimeoutMs: 100 });
    session.onConnected();
    session.onClientLine(req(7, "tools/call", { name: "session_load_context" }), 0);
    session.onDisconnected(1000);

    expect(session.checkTimeouts(1050)).toEqual([]);

    const timedOut = session.checkTimeouts(1150);
    expect(timedOut).toEqual([
      {
        to: "client",
        line: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          error: { code: -32000, message: "prism daemon unavailable" },
        }),
      },
    ]);

    expect(session.checkTimeouts(2000)).toEqual([]);
  });

  it("does not time out while connected", () => {
    const session = newSession({ requestTimeoutMs: 100 });
    session.onConnected();
    session.onClientLine(req(1, "tools/call", { name: "session_load_context" }), 0);
    expect(session.checkTimeouts(10_000)).toEqual([]);
  });
});

describe("ShimSession — daemon-to-client forwarding", () => {
  it("forwards a notification from the daemon verbatim", () => {
    const session = newSession();
    session.onConnected();
    const line = notif("notifications/message", { level: "info" });
    expect(session.onDaemonLine(line)).toEqual([{ to: "client", line }]);
  });

  it("forwards a server-initiated request (id + method) without touching in-flight, so it is never replayed as a client request", () => {
    const session = newSession();
    session.onConnected();

    const serverRequest = req("srv-1", "sampling/createMessage", { foo: "bar" });
    expect(session.onDaemonLine(serverRequest)).toEqual([{ to: "client", line: serverRequest }]);

    session.onDisconnected(0);
    const reconnectActions = toDaemon(session.onConnected());
    expect(reconnectActions).toEqual([
      JSON.stringify({ prism_hello: { v: 1, cwd: "/proj", clientId: "client-1" } }),
    ]);
  });
});

describe("ShimSession — client responses to server-initiated requests", () => {
  it("forwards a client response (id, no method) to the daemon without tracking it as in-flight", () => {
    const session = newSession();
    session.onConnected();

    const clientResponse = resp("srv-1", { ok: true });
    expect(session.onClientLine(clientResponse, 0)).toEqual([{ to: "daemon", line: clientResponse }]);

    session.onDisconnected(0);
    const reconnectActions = toDaemon(session.onConnected());
    expect(reconnectActions).toEqual([
      JSON.stringify({ prism_hello: { v: 1, cwd: "/proj", clientId: "client-1" } }),
    ]);
  });

  it("drops a client response instead of queueing it while disconnected", () => {
    const session = newSession();
    session.onConnected();
    session.onDisconnected(0);

    const clientResponse = resp("srv-1", { ok: true });
    expect(session.onClientLine(clientResponse, 0)).toEqual([]);

    const reconnectActions = toDaemon(session.onConnected());
    expect(reconnectActions).toEqual([
      JSON.stringify({ prism_hello: { v: 1, cwd: "/proj", clientId: "client-1" } }),
    ]);
  });
});

describe("ShimSession — notifications/cancelled", () => {
  it("removes the cancelled request id from in-flight so it is not replayed", () => {
    const session = newSession();
    session.onConnected();

    const line = req(4, "tools/call", { name: "session_load_context" });
    session.onClientLine(line, 0);

    session.onClientLine(notif("notifications/cancelled", { requestId: 4 }), 0);

    session.onDisconnected(0);
    const reconnectActions = toDaemon(session.onConnected());
    expect(reconnectActions).toEqual([
      JSON.stringify({ prism_hello: { v: 1, cwd: "/proj", clientId: "client-1" } }),
    ]);
  });
});

describe("ShimSession — idempotency key distinguishes id types", () => {
  it("uses JSON.stringify(id) so numeric 1 and string \"1\" produce different keys", () => {
    const session = newSession({ clientId: "abc" });
    session.onConnected();

    const numericLine = req(1, "tools/call", { name: "session_save_ledger", arguments: {} });
    const [numericAction] = toDaemon(session.onClientLine(numericLine, 0));
    const numericParsed = JSON.parse(numericAction);
    expect(numericParsed.params._meta["prism/idempotencyKey"]).toBe("abc:1");

    const stringLine = req("1", "tools/call", { name: "session_save_ledger", arguments: {} });
    const [stringAction] = toDaemon(session.onClientLine(stringLine, 0));
    const stringParsed = JSON.parse(stringAction);
    expect(stringParsed.params._meta["prism/idempotencyKey"]).toBe('abc:"1"');
  });
});
