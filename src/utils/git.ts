/**
 * Git Utility — Reality Drift Detection (v2.0 — Step 5)
 *
 * Safe, graceful interaction with the local Git repo.
 * Never throws — always returns a safe default if Git isn't available
 * or the project path isn't a repo.
 *
 * ═══════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS:
 *   When a developer manually refactors code between agent sessions,
 *   the agent's memory becomes stale ("reality drift"). Prism solves
 *   this by auto-capturing the Git state on every handoff save and
 *   checking for drift on every context load.
 *
 * DESIGN DECISIONS:
 *   - Uses stdio: 'pipe' to suppress stderr from non-repo directories.
 *   - getGitDrift uses --name-status (not raw diff) to protect the
 *     LLM's context window. A 10,000-line refactor shows up as just
 *     "M  src/schema.ts" — no token explosion.
 * ═══════════════════════════════════════════════════════════════════
 */


import { execFile } from "child_process";
import { promisify } from "util";
import { isAbsolute } from "path";
import { clientWorkingDirectory } from "./requestContext.js";

const execFileAsync = promisify(execFile);

export interface GitState {
  isRepo: boolean;
  branch: string | null;
  commitSha: string | null;
}

function resolveProjectPath(projectPath: string | undefined): string | undefined {
  return typeof projectPath === "string" && isAbsolute(projectPath) ? projectPath : undefined;
}

/**
 * Get the current Git branch and HEAD commit SHA.
 * Returns { isRepo: false } gracefully if not a Git repo.
 */
export async function getCurrentGitState(
  projectPath: string | undefined = clientWorkingDirectory()
): Promise<GitState> {
  const cwd = resolveProjectPath(projectPath);
  if (!cwd) return { isRepo: false, branch: null, commitSha: null };
  try {
    const { stdout: branchOut } = await execFileAsync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd, timeout: 5000 }
    );
    const branch = branchOut.toString().trim();

    const { stdout: shaOut } = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd, timeout: 5000 }
    );
    const commitSha = shaOut.toString().trim();

    return { isRepo: true, branch, commitSha };
  } catch {
    // Not a repo, git not installed, or timeout
    return { isRepo: false, branch: null, commitSha: null };
  }
}

/**
 * Get the list of files changed between `oldSha` and current HEAD.
 * Returns compact --name-status format (e.g., "M  src/index.ts").
 * Returns null if the SHA is invalid (rebased, force-pushed, etc.).
 */
export async function getGitDrift(
  oldSha: string,
  projectPath: string | undefined = clientWorkingDirectory()
): Promise<string | null> {
  // SECURITY: Validate SHA format before passing to git.
  // Without this, a corrupted DB entry like "; rm -rf /" would be
  // shell-injected via the old template string approach.
  if (!/^[0-9a-f]{4,40}$/i.test(oldSha)) {
    return null;
  }

  const cwd = resolveProjectPath(projectPath);
  if (!cwd) return null;

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--name-status", oldSha, "HEAD"],
      { cwd, timeout: 10000 }
    );
    const diff = stdout.toString().trim();

    return diff || null;
  } catch {
    // Old SHA was rebased/deleted, or not a repo
    return null;
  }
}
