import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

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
