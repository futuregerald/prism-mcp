import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export function getPrismDataDir(): string {
  const dir = process.env.PRISM_DATA_DIR || path.join(os.homedir(), ".prism-mcp");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

export function getSocketPath(): string {
  return process.env.PRISM_SOCKET || path.join(getPrismDataDir(), "prismd.sock");
}

export function getSpawnMarkerPath(): string {
  return path.join(getPrismDataDir(), "prismd.spawn");
}

export function getLogPath(): string {
  return path.join(getPrismDataDir(), "prismd.log");
}
