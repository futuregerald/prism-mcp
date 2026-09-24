import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export function getPrismDataDir(): string {
  const dir = process.env.PRISM_DATA_DIR || path.join(os.homedir(), ".prism-mcp");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink()) {
    throw new Error(`[dataDir] Refusing to use ${dir}: it is a symlink`);
  }
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error(`[dataDir] Refusing to use ${dir}: not owned by the current user`);
  }
  if ((st.mode & 0o077) !== 0) {
    fs.chmodSync(dir, 0o700);
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
