import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const TSC_BIN = path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");

interface GlobalSetupProject {
  config?: { watch?: boolean };
  vitest?: { config?: { watch?: boolean } };
}

export function isWatchMode(project?: GlobalSetupProject): boolean {
  return Boolean(
    project?.config?.watch
    ?? project?.vitest?.config?.watch
    ?? process.argv.includes("--watch")
  );
}

export default function globalSetup(project?: GlobalSetupProject): void {
  if (isWatchMode(project)) {
    process.stderr.write(
      "[globalSetup] watch mode detected — dist is built once for this watch session; re-run `npm run build` if you edit src/ files while watching.\n"
    );
  }
  execFileSync(process.execPath, [TSC_BIN], { cwd: REPO_ROOT, stdio: "inherit" });
}
