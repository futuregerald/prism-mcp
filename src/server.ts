import { shouldDelegateToSharedDaemon } from "./utils/sharedDaemonMode.js";

// Only auto-start when this module is executed directly.
// IMPORTANT: npm install -g creates a symlink like /usr/local/bin/prism-mcp-server
// whose path does NOT end with 'server.js'. Node.js sets process.argv[1] to the
// symlink path, not the resolved target. Without the bin-name check, startServer()
// never fires and the process silently exits with zero stdout (see issue #21).
const entryScript = process.argv[1] ?? '';
const isDirectExecution =
  entryScript.endsWith('server.js') ||
  entryScript.endsWith('server.ts') ||
  entryScript.endsWith('prism-mcp-server');

function exitWithFatalError(error: unknown): never {
  console.error('Fatal error running server:', error);
  process.exit(1);
}

if (isDirectExecution) {
  let delegate = false;
  try {
    delegate = shouldDelegateToSharedDaemon();
  } catch (error) {
    exitWithFatalError(error);
  }

  if (delegate) {
    await import("./shim.js");
  } else {
    const { startServer } = await import("./mcpServer.js");
    startServer().catch(exitWithFatalError);
  }
}
