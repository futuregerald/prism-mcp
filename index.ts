#!/usr/bin/env node
import { startServer, createSandboxServer } from "./src/mcpServer.js";

// Re-export for Smithery capability scanning
export { createSandboxServer };




// Add more responsive signal handling
process.on('SIGINT', () => {
  console.error('Received SIGINT signal, shutting down gracefully');
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
});

// Run the server
startServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
