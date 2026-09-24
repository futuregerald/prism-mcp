import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { debugLog } from "./utils/logger.js";

const servers = new Set<Server>();
const subscriptions = new Map<Server, Set<string>>();

export function registerServer(server: Server): void {
  servers.add(server);
  subscriptions.set(server, new Set());
}

export function unregisterServer(server: Server): void {
  servers.delete(server);
  subscriptions.delete(server);
}

export function getRegisteredServers(): Server[] {
  return Array.from(servers);
}

export function subscribeServerToUri(server: Server, uri: string): void {
  subscriptions.get(server)?.add(uri);
}

export function unsubscribeServerFromUri(server: Server, uri: string): void {
  subscriptions.get(server)?.delete(uri);
}

export function getServersSubscribedTo(uri: string): Server[] {
  const result: Server[] = [];
  for (const server of servers) {
    if (subscriptions.get(server)?.has(uri)) {
      result.push(server);
    }
  }
  return result;
}

export function broadcastLog(params: Parameters<Server["sendLoggingMessage"]>[0]): void {
  for (const server of servers) {
    try {
      server.sendLoggingMessage(params).catch(err => {
        debugLog(`[ConnectionRegistry] broadcastLog send failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      });
    } catch (err) {
      debugLog(`[ConnectionRegistry] broadcastLog send threw (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
