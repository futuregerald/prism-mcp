/**
 * Tracks every live MCP `Server` instance so background subsystems (SyncBus,
 * watchdog, etc.) can broadcast a logging notification to all of them.
 *
 * In stdio mode there is exactly one server, registered once at startup.
 * In daemon mode there is one server per client connection, registered on
 * connect and unregistered on disconnect.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

const servers = new Set<Server>();

export function registerServer(server: Server): void {
  servers.add(server);
}

export function unregisterServer(server: Server): void {
  servers.delete(server);
}

export function getRegisteredServers(): Server[] {
  return Array.from(servers);
}

export function broadcastLog(params: Parameters<Server["sendLoggingMessage"]>[0]): void {
  for (const server of servers) {
    try {
      server.sendLoggingMessage(params);
    } catch {
      // sendLoggingMessage is best-effort per connection.
    }
  }
}
