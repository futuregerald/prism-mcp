import * as crypto from "node:crypto";

export function computeConfigFingerprint(env: NodeJS.ProcessEnv = process.env): string {
  const parts = [env.PRISM_USER_ID ?? "", env.PRISM_STORAGE ?? "", env.SUPABASE_URL ?? ""];
  return crypto.createHash("sha256").update(parts.join("\u0000")).digest("hex");
}
