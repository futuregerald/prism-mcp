import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export function getPrismDataDir(): string {
  const dir = process.env.PRISM_DATA_DIR || path.join(os.homedir(), ".prism-mcp");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}
