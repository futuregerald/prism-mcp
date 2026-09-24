import * as fs from "node:fs";
import * as path from "node:path";
import { getPrismDataDir } from "./dataDir.js";

export const SHARED_DAEMON_MARKER = "shared-daemon";

export function shouldDelegateToSharedDaemon(): boolean {
  const flag = (process.env.PRISM_SHARED_DAEMON ?? "").trim().toLowerCase();
  if (flag === "0" || flag === "false") return false;
  if (flag === "1" || flag === "true") return true;
  return fs.existsSync(path.join(getPrismDataDir(), SHARED_DAEMON_MARKER));
}
