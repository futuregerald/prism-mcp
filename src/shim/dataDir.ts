import * as fs from "fs";
import * as path from "path";

export { getPrismDataDir } from "../utils/dataDir.js";
import { getPrismDataDir } from "../utils/dataDir.js";

export function getSocketPath(): string {
  return process.env.PRISM_SOCKET || path.join(getPrismDataDir(), "prismd.sock");
}

export function getSpawnMarkerPath(): string {
  return path.join(getPrismDataDir(), "prismd.spawn");
}

export function getLogPath(): string {
  return path.join(getPrismDataDir(), "prismd.log");
}

const LOG_ROTATE_MAX_BYTES = 10 * 1024 * 1024;

export function openDaemonLogFd(logPath: string): number {
  try {
    const st = fs.statSync(logPath);
    if (st.size > LOG_ROTATE_MAX_BYTES) {
      fs.renameSync(logPath, `${logPath}.1`);
    }
  } catch { }
  const fd = fs.openSync(
    logPath,
    fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
    0o600
  );
  fs.fchmodSync(fd, 0o600);
  return fd;
}
