import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const verifiedResolvedDirs = new Set<string>();

export function isOwnedByCurrentUser(uid: number): boolean {
  if (typeof process.getuid !== "function") return true;
  return uid === process.getuid();
}

function ensureResolvedDirOwnedAndPrivate(resolvedDir: string): void {
  if (verifiedResolvedDirs.has(resolvedDir)) return;

  const st = fs.statSync(resolvedDir);
  if (!st.isDirectory()) {
    throw new Error(`[dataDir] Refusing to use ${resolvedDir}: not a directory`);
  }
  if (!isOwnedByCurrentUser(st.uid)) {
    throw new Error(`[dataDir] Refusing to use ${resolvedDir}: not owned by the current user`);
  }
  if ((st.mode & 0o077) !== 0) {
    fs.chmodSync(resolvedDir, 0o700);
  }

  verifiedResolvedDirs.add(resolvedDir);
}

export interface SocketPathCheck {
  ok: boolean;
  reason?: string;
}

export function checkExplicitSocketPath(socketPath: string): SocketPathCheck {
  const dir = path.dirname(socketPath);
  let st: fs.Stats;
  try {
    st = fs.statSync(dir);
  } catch (err) {
    return {
      ok: false,
      reason: `PRISM_SOCKET directory ${dir} is not accessible: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!st.isDirectory()) {
    return { ok: false, reason: `PRISM_SOCKET directory ${dir} is not a directory` };
  }
  if (!isOwnedByCurrentUser(st.uid)) {
    return { ok: false, reason: `PRISM_SOCKET directory ${dir} is not owned by the current user` };
  }
  if ((st.mode & 0o022) !== 0) {
    return { ok: false, reason: `PRISM_SOCKET directory ${dir} is group- or world-writable` };
  }
  return { ok: true };
}

export function getPrismDataDir(): string {
  const dir = process.env.PRISM_DATA_DIR || path.join(os.homedir(), ".prism-mcp");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  const resolvedDir = fs.realpathSync(dir);
  ensureResolvedDirOwnedAndPrivate(resolvedDir);

  return dir;
}
