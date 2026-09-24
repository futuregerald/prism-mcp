import * as fs from "node:fs";
import * as path from "node:path";
import { getPrismDataDir, isOwnedByCurrentUser } from "./dataDir.js";

export const SHARED_DAEMON_MARKER = "shared-daemon";

function markerIsOwnedRegularFile(markerPath: string): boolean {
  const st = fs.lstatSync(markerPath, { throwIfNoEntry: false });
  return !!st && st.isFile() && isOwnedByCurrentUser(st.uid);
}

export function shouldDelegateToSharedDaemon(): boolean {
  if (process.platform === "win32") return false;
  const flag = (process.env.PRISM_SHARED_DAEMON ?? "").trim().toLowerCase();
  if (flag === "0" || flag === "false") return false;
  if (flag === "1" || flag === "true") return true;
  return markerIsOwnedRegularFile(path.join(getPrismDataDir(), SHARED_DAEMON_MARKER));
}
