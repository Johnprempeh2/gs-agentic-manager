import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testEnvironment } from "@greatstone/adapter-claude-local/server";
import type { AiCredentialInfo } from "@greatstone/shared";
import { unprocessable } from "../errors.js";

/** `claude setup-token` issues a token that lasts one year; the CLI does not report the date. */
export const CLAUDE_SETUP_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

/** Auth works on these; a spent usage window is not a bad token. */
const ACCEPTED_PROBE_CODES = new Set(["claude_hello_probe_passed", "claude_hello_probe_usage_limited"]);

/**
 * Check a pasted `claude setup-token` value with the Claude hello probe before
 * it is saved. The probe runs the CLI engine with only this token and an empty,
 * throwaway config directory, so the Mac's own Claude login can never make a
 * bad token pass. Errors are fixed text: CLI output may echo the token.
 */
export async function verifyClaudeSetupToken(
  companyId: string,
  rawToken: string,
  probe: typeof testEnvironment = testEnvironment,
  now = new Date(),
): Promise<{ credential: string; info: AiCredentialInfo }> {
  const token = rawToken.trim();
  if (token.startsWith("sk-ant-api"))
    throw unprocessable("This is an API key, not a subscription token. Run claude setup-token in a terminal and paste the token it prints.");
  if (!/^sk-ant-oat\d*-[A-Za-z0-9_-]+$/.test(token))
    throw unprocessable("This does not look like a token from claude setup-token. Copy the whole token it prints (it starts with sk-ant-oat) and try again.");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "gsam-claude-setup-token-"));
  let accepted = false;
  try {
    const result = await probe({
      companyId,
      adapterType: "claude_local",
      config: {
        engine: "cli",
        cwd: home,
        env: { CLAUDE_CODE_OAUTH_TOKEN: token, CLAUDE_CONFIG_DIR: home },
      },
    });
    accepted = result.checks.some((check) => ACCEPTED_PROBE_CODES.has(check.code));
  } catch {
    accepted = false;
  } finally {
    await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
  if (!accepted)
    throw unprocessable("Claude did not accept this token. Run claude setup-token again, paste the new token, and try again. Nothing was changed.");
  return {
    credential: token,
    info: { source: "setup_token", expiresAt: new Date(now.getTime() + CLAUDE_SETUP_TOKEN_LIFETIME_MS).toISOString() },
  };
}
