import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { createDb } from "@greatstone/db";
import { loadPaperclipEnvFile } from "../config/env.js";
import { readConfig, resolveConfigPath } from "../config/store.js";

/**
 * Finds the database of the install whose config path is given. An install
 * started with `--data-dir` and no `config.json` (John's live install) runs
 * embedded Postgres under `<instance>/db`; its `postmaster.pid` names the port.
 */
export function resolveResetPasswordDbUrl(configPath: string, explicitDbUrl?: string): string | null {
  if (explicitDbUrl) return explicitDbUrl;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const config = readConfig(configPath);
  if (config?.database.mode === "postgres" && config.database.connectionString) {
    return config.database.connectionString;
  }
  const dataDir = config?.database.embeddedPostgresDataDir ?? path.join(path.dirname(configPath), "db");
  const port = readEmbeddedPostgresPort(dataDir) ?? config?.database.embeddedPostgresPort ?? null;
  return port ? `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip` : null;
}

export function readEmbeddedPostgresPort(dataDir: string): number | null {
  try {
    // postmaster.pid line 4 is the port the running cluster listens on.
    const line = fs.readFileSync(path.join(dataDir, "postmaster.pid"), "utf8").split(/\r?\n/)[3];
    const port = Number(line?.trim());
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

async function promptForPassword(): Promise<string | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    p.log.error("No terminal to ask for the password. Use --password-stdin or --generate.");
    return null;
  }
  const first = await p.password({ message: "New password (8+ characters)" });
  if (p.isCancel(first)) return null;
  const second = await p.password({ message: "Type it again" });
  if (p.isCancel(second)) return null;
  if (first !== second) {
    p.log.error("The two passwords do not match.");
    return null;
  }
  return first;
}

export async function resetBoardPassword(opts: {
  email: string;
  config?: string;
  dbUrl?: string;
  passwordStdin?: boolean;
  generate?: boolean;
}): Promise<void> {
  const configPath = resolveConfigPath(opts.config);
  loadPaperclipEnvFile(configPath);

  let password: string | null;
  if (opts.generate) {
    password = randomBytes(15).toString("base64url");
  } else if (opts.passwordStdin) {
    password = await readStdin();
  } else {
    password = await promptForPassword();
  }
  if (!password) {
    process.exitCode = 1;
    return;
  }

  const dbUrl = resolveResetPasswordDbUrl(configPath, opts.dbUrl);
  if (!dbUrl) {
    p.log.error("Could not find the database. Start the GS Agentic Manager server, or pass --db-url.");
    process.exitCode = 1;
    return;
  }

  const { resetCredentialPassword } = await import("@greatstone/server/auth/reset-password");
  const db = createDb(dbUrl);
  const closableDb = db as typeof db & { $client?: { end?: (options?: { timeout?: number }) => Promise<void> } };
  try {
    const result = await resetCredentialPassword(db, { email: opts.email, newPassword: password });
    p.log.success(`Password reset for ${pc.cyan(result.email)}.`);
    p.log.message(`Signed out ${result.sessionsRevoked} session(s); sign in again on each device.`);
    if (opts.generate) p.log.message(`New password: ${pc.bold(password)}`);
  } catch (err) {
    p.log.error(`Could not reset the password: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await closableDb.$client?.end?.({ timeout: 5 }).catch(() => undefined);
  }
}
