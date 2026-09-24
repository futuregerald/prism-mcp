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
    }
  }
}
