import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { parse as parseEnvFileContents } from "dotenv";
import { updateEnvFileContents, writeEnvFileAtomicallyIfChanged } from "@greatstone/shared/env-file";
import { normalizeHostnameInput } from "../config/hostnames.js";
import { resolveConfigPath } from "../config/store.js";

export const AUTH_MODES = ["authenticated", "local_trusted"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];
export const AUTHENTICATED_BINDS = ["lan", "loopback", "tailnet"] as const;
export type AuthenticatedBind = (typeof AUTHENTICATED_BINDS)[number];
export type SignUpPolicy = "open" | "closed";

const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1"];

/**
 * The instance `.env` keys this command owns. The server reads each of them in
 * `server/src/config.ts` and they win over `config.json`, so the switch works
 * the same on an install that has no `config.json` at all.
 */
export type AuthModeEnvEntries = Record<string, string>;

/**
 * Pure planner for `gsam auth mode` (GRE-125): given the current instance
 * `.env` values, returns the entries to write. Never removes a key, so the
 * switch back to `local_trusted` is the same kind of edit as the switch out.
 *
 * Secrets are kept once written. On the first switch the agent JWT secret is
 * pinned to the instance's generated key, because the server prefers
 * `BETTER_AUTH_SECRET` over that key file: without the pin, adding the Better
 * Auth secret would silently re-key every agent run token.
 */
export function planAuthModeEnv(input: {
  mode: AuthMode;
  current: Record<string, string>;
  bind?: AuthenticatedBind;
  allowedHostnames?: string[];
  signUp?: SignUpPolicy;
  generatedAgentJwtKey: string | null;
  randomSecret?: () => string;
}): AuthModeEnvEntries {
  const randomSecret = input.randomSecret ?? (() => randomBytes(32).toString("hex"));
  const current = input.current;
  const entries: AuthModeEnvEntries = {};

  const agentJwtSecret = current.GSAM_AGENT_JWT_SECRET?.trim();
  if (!agentJwtSecret) {
    entries.GSAM_AGENT_JWT_SECRET = input.generatedAgentJwtKey?.trim() || randomSecret();
  }

  if (input.mode === "local_trusted") {
    entries.GSAM_DEPLOYMENT_MODE = "local_trusted";
    entries.GSAM_DEPLOYMENT_EXPOSURE = "private";
    entries.GSAM_BIND = "loopback";
    return entries;
  }

  entries.GSAM_DEPLOYMENT_MODE = "authenticated";
  entries.GSAM_DEPLOYMENT_EXPOSURE = "private";
  entries.GSAM_BIND = input.bind ?? "lan";
  if (!current.BETTER_AUTH_SECRET?.trim()) {
    entries.BETTER_AUTH_SECRET = randomSecret();
  }

  const hostnames = new Set<string>(LOOPBACK_HOSTNAMES);
  for (const value of (current.GSAM_ALLOWED_HOSTNAMES ?? "").split(",")) {
    const trimmed = value.trim().toLowerCase();
    if (trimmed) hostnames.add(trimmed);
  }
  for (const value of input.allowedHostnames ?? []) {
    hostnames.add(normalizeHostnameInput(value));
  }
  entries.GSAM_ALLOWED_HOSTNAMES = Array.from(hostnames).sort().join(",");

  if (input.signUp) {
    entries.GSAM_AUTH_DISABLE_SIGN_UP = input.signUp === "closed" ? "true" : "false";
  } else if (current.GSAM_AUTH_DISABLE_SIGN_UP === undefined) {
    // The first switch leaves sign-up open so the owner can create the one
    // account; the run-book closes it right after the board claim.
    entries.GSAM_AUTH_DISABLE_SIGN_UP = "false";
  }
  return entries;
}

function readEnvFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function readGeneratedAgentJwtKey(instanceRoot: string): string | null {
  try {
    return fs.readFileSync(path.join(instanceRoot, "secrets", "agent-jwt.key"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function timestampSuffix(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, "-");
}

export function setAuthMode(
  mode: string,
  opts: {
    config?: string;
    bind?: string;
    allowedHostname?: string[];
    signUp?: string;
  },
): { envPath: string; backupPath: string | null; entries: AuthModeEnvEntries } | null {
  if (!AUTH_MODES.includes(mode as AuthMode)) {
    p.log.error(`Mode must be one of: ${AUTH_MODES.join(", ")}.`);
    process.exitCode = 1;
    return null;
  }
  if (opts.bind && !AUTHENTICATED_BINDS.includes(opts.bind as AuthenticatedBind)) {
    p.log.error(`--bind must be one of: ${AUTHENTICATED_BINDS.join(", ")}.`);
    process.exitCode = 1;
    return null;
  }
  if (opts.signUp && opts.signUp !== "open" && opts.signUp !== "closed") {
    p.log.error("--sign-up must be open or closed.");
    process.exitCode = 1;
    return null;
  }
  if (mode === "local_trusted" && (opts.bind || opts.signUp || opts.allowedHostname?.length)) {
    p.log.error("--bind, --sign-up and --allowed-hostname apply to authenticated mode only.");
    process.exitCode = 1;
    return null;
  }

  const configPath = resolveConfigPath(opts.config);
  const instanceRoot = path.dirname(configPath);
  const envPath = path.join(instanceRoot, ".env");
  const previous = readEnvFile(envPath);
  const current = previous === null ? {} : parseEnvFileContents(previous);

  const entries = planAuthModeEnv({
    mode: mode as AuthMode,
    current,
    bind: opts.bind as AuthenticatedBind | undefined,
    allowedHostnames: opts.allowedHostname,
    signUp: opts.signUp as SignUpPolicy | undefined,
    generatedAgentJwtKey: readGeneratedAgentJwtKey(instanceRoot),
  });

  const next = updateEnvFileContents(previous ?? "# GS Agentic Manager environment variables\n", entries);
  let backupPath: string | null = null;
  if (previous !== null && previous !== next) {
    backupPath = `${envPath}.before-auth-mode-${timestampSuffix()}`;
    fs.writeFileSync(backupPath, previous, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
  const changed = writeEnvFileAtomicallyIfChanged(envPath, previous, next);

  const shown = Object.entries(entries)
    .filter(([key]) => key !== "BETTER_AUTH_SECRET" && key !== "GSAM_AGENT_JWT_SECRET")
    .map(([key, value]) => `${key}=${value}`);
  if (!changed) {
    p.log.info(`Already set for ${pc.cyan(mode)} in ${envPath}.`);
  } else {
    p.log.success(`Set ${pc.cyan(mode)} in ${envPath}.`);
    for (const line of shown) p.log.message(pc.dim(`  ${line}`));
    if (entries.BETTER_AUTH_SECRET) p.log.message(pc.dim("  BETTER_AUTH_SECRET=<new, hidden>"));
    if (entries.GSAM_AGENT_JWT_SECRET) p.log.message(pc.dim("  GSAM_AGENT_JWT_SECRET=<pinned, hidden>"));
    if (backupPath) p.log.message(pc.dim(`Previous file saved as ${backupPath}`));
  }
  p.log.message("Restart the GS Agentic Manager server for this change to take effect.");
  return { envPath, backupPath, entries };
}
