import { describe, it, expect } from "vitest";
import { ShimSession, type ShimAction } from "../../src/shim/session.js";

const MUTATING = ["session_save_ledger"];

function newSession(overrides: Partial<{ clientId: string; cwd: string; requestTimeoutMs: number; configFingerprint?: string }> = {}) {
  return new ShimSession({
    clientId: overrides.clientId ?? "client-1",
    cwd: overrides.cwd ?? "/proj",
    mutatingTools: MUTATING,
    requestTimeoutMs: overrides.requestTimeoutMs ?? 1000,
    configFingerprint: overrides.configFingerprint,
  });
}

function toDaemon(actions: ShimAction[]): string[] {
  return actions.filter(a => a.to === "daemon").map(a => a.line);
}

function toClient(actions: ShimAction[]): any[] {
  return actions.filter(a => a.to === "client").map(a => JSON.parse(a.line));
}

function req(id: number | string, method: string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function resp(id: number | string, result: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function errResp(id: number | string, message = "boom"): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code: -1, message } });
}

const hello = () => JSON.stringify({ prism_hello_error: { reason: "config_mismatch" } });

describe("ShimSession — configFingerprint in hello", () => {
  it("includes configFingerprint in prism_hello when provided", () => {
    const session = newSession({ configFingerprint: "abc123" });
    const [line] = toDaemon(session.onConnected());
    expect(JSON.parse(line)).toEqual({
      prism_hello: { v: 1, cwd: "/proj", clientId: "client-1", configFingerprint: "abc123" },
    });
  });

  it("omits configFingerprint from prism_hello when not provided", () => {
    const session = newSession();
    const [line] = toDaemon(session.onConnected());
    expect(JSON.parse(line)).toEqual({ prism_hello: { v: 1, cwd: "/proj", clientId: "client-1" } });
  });
});

describe("ShimSession — config mismatch fatal mode", () => {
  it("answers pending requests with -32001 and enters fatal mode on prism_hello_error", () => {
    const session = newSession();
    session.onConnected();
    session.onClientLine(req(1, "tools/call", { name: "session_load_context" }), 0);

    const actions = toClient(session.onDaemonLine(hello()));
    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe(1);
    expect(actions[0].error.code).toBe(-32001);
    expect(actions[0].error.message).toMatch(/PRISM_USER_ID/);
    expect(session.isFatal()).toBe(true);
  });

  it("immediately errors new client requests once fatal", () => {
    const session = newSession();
    session.onConnected();
    session.onDaemonLine(hello());

    const actions = toClient(session.onClientLine(req(2, "tools/call", { name: "session_load_context" }), 0));
    expect(actions).toHaveLength(1);
    expect(actions[0].error.code).toBe(-32001);
  });

  it("drops client notifications once fatal instead of queueing them", () => {
    const session = newSession();
    session.onConnected();
    session.onDaemonLine(hello());

    const actions = session.onClientLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" }), 0);
    expect(actions).toEqual([]);
  });

  it("stays fatal even if a second prism_hello_error arrives", () => {
    const session = newSession();
    session.onConnected();
    session.onDaemonLine(hello());
    const actions = session.onDaemonLine(hello());
    expect(actions).toEqual([]);
    expect(session.isFatal()).toBe(true);
  });
});

describe("ShimSession — resources/subscribe replay", () => {
  it("replays a successfully subscribed resource after reconnect with a synthetic id", () => {
    const session = newSession();
    session.onConnected();

    session.onClientLine(req(1, "resources/subscribe", { uri: "prism://foo" }), 0);
    session.onDaemonLine(resp(1, {}));

    session.onDisconnected(0);
    const actions = toDaemon(session.onConnected());

    const replay = actions.map(l => JSON.parse(l)).find(m => m.method === "resources/subscribe");
    expect(replay).toBeDefined();
    expect(replay.params).toEqual({ uri: "prism://foo" });
    expect(String(replay.id)).toMatch(/^prism-shim-replay-/);
  });

  it("does not replay a subscribe that the daemon rejected with an error", () => {
    const session = newSession();
    session.onConnected();

    session.onClientLine(req(1, "resources/subscribe", { uri: "prism://foo" }), 0);
    session.onDaemonLine(errResp(1));

    session.onDisconnected(0);
    const actions = toDaemon(session.onConnected());
    const replay = actions.map(l => JSON.parse(l)).find(m => m.method === "resources/subscribe");
    expect(replay).toBeUndefined();
  });

  it("stops replaying a resource after a successful unsubscribe", () => {
    const session = newSession();
    session.onConnected();

    session.onClientLine(req(1, "resources/subscribe", { uri: "prism://foo" }), 0);
    session.onDaemonLine(resp(1, {}));
    session.onClientLine(req(2, "resources/unsubscribe", { uri: "prism://foo" }), 0);
    session.onDaemonLine(resp(2, {}));

    session.onDisconnected(0);
    const actions = toDaemon(session.onConnected());
    const replay = actions.map(l => JSON.parse(l)).find(m => m.method === "resources/subscribe");
    expect(replay).toBeUndefined();
  });

  it("swallows the daemon's response to a replayed subscribe", () => {
    const session = newSession();
    session.onConnected();
    session.onClientLine(req(1, "resources/subscribe", { uri: "prism://foo" }), 0);
    session.onDaemonLine(resp(1, {}));
    session.onDisconnected(0);
    const actions = toDaemon(session.onConnected());
    const replay = actions.map(l => JSON.parse(l)).find(m => m.method === "resources/subscribe");

    const swallowed = session.onDaemonLine(resp(replay.id, {}));
    expect(swallowed).toEqual([]);
  });
});

describe("ShimSession — logging/setLevel replay", () => {
  it("replays the last logging/setLevel after reconnect", () => {
    const session = newSession();
    session.onConnected();

    session.onClientLine(req(1, "logging/setLevel", { level: "debug" }), 0);
    session.onDaemonLine(resp(1, {}));
    session.onClientLine(req(2, "logging/setLevel", { level: "warning" }), 0);
    session.onDaemonLine(resp(2, {}));

    session.onDisconnected(0);
    const actions = toDaemon(session.onConnected());
    const replay = actions.map(l => JSON.parse(l)).find(m => m.method === "logging/setLevel" && String(m.id).startsWith("prism-shim-replay-"));

    expect(replay).toBeDefined();
    expect(replay.params).toEqual({ level: "warning" });
    expect(String(replay.id)).toMatch(/^prism-shim-replay-/);
  });
});

describe("ShimSession — crash-loop replay cap", () => {
  it("answers with -32002 and drops the request instead of sending it a 3rd time", () => {
    const session = newSession();
    session.onConnected();

    session.onClientLine(req(1, "tools/list"), 0);
    session.onDaemonLine(resp(1, {}));
    session.onClientLine(req(9, "tools/call", { name: "session_load_context" }), 0);

    session.onDisconnected(0);
    const firstReplay = toDaemon(session.onConnected());
    expect(firstReplay.some(l => JSON.parse(l).id === 9)).toBe(true);
    const reinit = firstReplay.map(l => JSON.parse(l)).find(m => String(m.id).startsWith("prism-shim-reinit-"));
    session.onDaemonLine(resp(reinit?.id ?? "prism-shim-reinit-1", {}));

    session.onDisconnected(0);
    const secondActions = session.onConnected();
    const daemonActions = toDaemon(secondActions);
    const clientActions = toClient(secondActions);

    expect(daemonActions.some(l => { try { return JSON.parse(l).id === 9; } catch { return false; } })).toBe(false);
    const errored = clientActions.find(m => m.id === 9);
    expect(errored).toBeDefined();
    expect(errored.error.code).toBe(-32002);
    expect(errored.error.message).toMatch(/not retried/);
  });
});

describe("ShimSession — crash-loop cap ignores daemons that died before answering anything", () => {
  it("keeps replaying a request across daemons that were killed while still booting", () => {
    const session = newSession();
    session.onConnected();
    session.onClientLine(req(7, "tools/call", { name: "session_save_ledger", arguments: { summary: "s" } }), 0);

    for (let death = 0; death < 5; death++) {
      session.onDisconnected(0);
      const actions = session.onConnected();
      expect(toDaemon(actions).some(l => { try { return JSON.parse(l).id === 7; } catch { return false; } })).toBe(true);
      expect(toClient(actions).find(m => m.id === 7)).toBeUndefined();
    }
  });

  it("still fails a request whose daemon answered other traffic and then died twice", () => {
    const session = newSession();
    session.onConnected();
    session.onClientLine(req(0, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }), 0);
    session.onDaemonLine(resp(0, {}));
    session.onClientLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), 0);
    session.onClientLine(req(1, "tools/list"), 0);
    session.onDaemonLine(resp(1, {}));
    session.onClientLine(req(8, "tools/call", { name: "session_load_context" }), 0);

    session.onDisconnected(0);
    const replay = toDaemon(session.onConnected()).map(l => JSON.parse(l));
    const reinit = replay.find(m => String(m.id).startsWith("prism-shim-reinit-"));
    session.onDaemonLine(resp(reinit.id, {}));

    session.onDisconnected(0);
    const final = toClient(session.onConnected());
    expect(final.find(m => m.id === 8)?.error?.code).toBe(-32002);
  });
});

describe("ShimSession — failInFlightRequest", () => {
  it("removes the entry and answers the client, so it is not replayed", () => {
    const session = newSession();
    session.onConnected();
    session.onClientLine(req(3, "tools/call", { name: "session_load_context" }), 0);

    const actions = toClient(session.failInFlightRequest(3, -32004, "oversized response"));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({ jsonrpc: "2.0", id: 3, error: { code: -32004, message: "oversized response" } });

    session.onDisconnected(0);
    const reconnectActions = toDaemon(session.onConnected());
    expect(reconnectActions.some(l => { try { return JSON.parse(l).id === 3; } catch { return false; } })).toBe(false);
  });

  it("returns no actions for an id that is not in flight", () => {
    const session = newSession();
    expect(session.failInFlightRequest(999, -32004, "x")).toEqual([]);
  });
});

describe("ShimSession — failAllPendingWithError", () => {
  it("answers every in-flight request and clears them, without entering fatal mode", () => {
    const session = newSession();
    session.onConnected();
    session.onClientLine(req(1, "tools/call", { name: "session_load_context" }), 0);
    session.onClientLine(req(2, "tools/call", { name: "session_load_context" }), 0);

    const actions = toClient(session.failAllPendingWithError(-32003, "prism daemon failed to start; see /tmp/x/prismd.log"));
    expect(actions.map(a => a.id).sort()).toEqual([1, 2]);
    for (const action of actions) {
      expect(action.error).toEqual({ code: -32003, message: "prism daemon failed to start; see /tmp/x/prismd.log" });
    }
    expect(session.isFatal()).toBe(false);

    const followUp = toClient(session.onClientLine(req(3, "tools/call", { name: "session_load_context" }), 0));
    expect(followUp).toEqual([]);
  });

  it("returns no actions when nothing is in flight", () => {
    const session = newSession();
    expect(session.failAllPendingWithError(-32003, "x")).toEqual([]);
  });
});
