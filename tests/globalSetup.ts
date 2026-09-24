import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

export default function globalSetup(): void {
  execFileSync("npx", ["tsc"], { cwd: REPO_ROOT, stdio: "inherit" });
}
