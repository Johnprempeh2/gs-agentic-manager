import * as p from "@clack/prompts";
import pc from "picocolors";
import { createDb } from "@greatstone/db";
import { loadPaperclipEnvFile } from "../config/env.js";
import { resolveConfigPath } from "../config/store.js";
import { resolveResetPasswordDbUrl } from "./auth-reset-password.js";

/**
 * The operator's way back in when a person has lost their phone and backup
 * codes and nobody on the instance can reset it for them (for example the
 * only owner). Runs against the database directly, so it needs shell access
 * to the host.
 */
export async function resetBoardTwoStep(opts: { email: string; config?: string; dbUrl?: string }): Promise<void> {
  const configPath = resolveConfigPath(opts.config);
  loadPaperclipEnvFile(configPath);
  const dbUrl = resolveResetPasswordDbUrl(configPath, opts.dbUrl);
  if (!dbUrl) {
    p.log.error("Could not find the database. Start the GS Agentic Manager server, or pass --db-url.");
    process.exitCode = 1;
    return;
  }

  const { resetTwoStepSignIn } = await import("@greatstone/server/auth/reset-password");
  const db = createDb(dbUrl);
  const closableDb = db as typeof db & { $client?: { end?: (options?: { timeout?: number }) => Promise<void> } };
  try {
    const result = await resetTwoStepSignIn(db, { email: opts.email });
    if (result.wasEnabled) {
      p.log.success(`Two-step sign-in reset for ${pc.cyan(result.email)}.`);
    } else {
      p.log.message(`Two-step sign-in was already off for ${pc.cyan(result.email)}.`);
    }
    p.log.message(`Signed out ${result.sessionsRevoked} session(s). They sign in with their password and set it up again.`);
  } catch (err) {
    p.log.error(`Could not reset two-step sign-in: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await closableDb.$client?.end?.({ timeout: 5 }).catch(() => undefined);
  }
}
