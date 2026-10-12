import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  RUN_SECRET_VALUE_REDACTION,
  collectRunSecretValues,
  redactRunSecretValues,
} from "@greatstone/adapter-utils/run-secret-values";

// ACP session records saved before #290 hold the run environment (API keys,
// git tokens, provider keys) in `acpx.session_options.env`. #290 stops new
// saves and strips `env` when a record is saved again, but records that are
// never resumed keep it forever (GRE-510). This one-time startup scrub removes
// the field from every record on disk. A marker file makes later starts skip
// the walk; the marker is written only when no file failed, so a failed write
// is retried on the next start.
//
// v2 (GRE-517): agents that printed their environment also left the same
// values in tool output inside `messages`. v2 redacts the record's own env
// values everywhere in the record, and because v1 may already have removed
// `env`, also any run token by shape (a JWT whose claims carry `run_id`; run
// API keys and GitHub broker tokens both do). The v2 marker makes instances
// that finished v1 walk the records once more.

export const ACP_SESSION_ENV_SCRUB_MARKER = ".acp-session-env-scrub-v2.json";
const JWT_SHAPE = /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g;

function isRunToken(token: string): boolean {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
    return typeof claims?.run_id === "string" && typeof claims?.sub === "string";
  } catch {
    return false;
  }
}

function redactRunTokens(text: string): string {
  return text.replace(JWT_SHAPE, (token) => (isRunToken(token) ? RUN_SECRET_VALUE_REDACTION : token));
}

/** Redact the record's own env values and any run token, in every string. */
function redactRecordSecrets(record: unknown, env: unknown): unknown {
  const envValues = collectRunSecretValues(env && typeof env === "object" ? (env as Record<string, unknown>) : {});
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return redactRunTokens(redactRunSecretValues(node, envValues));
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) out[key] = walk(child);
      return out;
    }
    return node;
  };
  return walk(record);
}

const MAX_REPORTED_PATHS = 20;

export interface AcpSessionEnvScrubResult {
  /** True when the marker showed an earlier start already finished the scrub. */
  alreadyDone: boolean;
  scanned: number;
  cleaned: number;
  /** Files that did not parse; left untouched. */
  unparseable: number;
  /** Files that could not be read or written, or changed during the scrub. */
  failed: number;
  /** Up to 20 skipped file paths, for the log line. Never file contents. */
  skippedPaths: string[];
}

async function listDirectories(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(dir, entry.name));
}

async function listSessionFiles(instanceRoot: string): Promise<string[]> {
  const files: string[] = [];
  for (const companyDir of await listDirectories(path.join(instanceRoot, "companies"))) {
    for (const agentDir of await listDirectories(path.join(companyDir, "acp-engine", "agents"))) {
      const sessionsDir = path.join(agentDir, "sessions");
      const entries = await readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".json")) files.push(path.join(sessionsDir, entry.name));
      }
    }
  }
  return files;
}

type ScrubOutcome = "unchanged" | "cleaned" | "unparseable" | "failed";

async function scrubSessionFile(file: string): Promise<ScrubOutcome> {
  let before;
  let text: string;
  try {
    before = await stat(file);
    text = await readFile(file, "utf8");
  } catch {
    return "failed";
  }
  // Cheap pre-check: a record with neither the key nor a token needs no parse.
  if (!text.includes("\"env\"") && !text.includes("eyJ")) return "unchanged";

  let record: unknown;
  try {
    record = JSON.parse(text);
  } catch {
    return "unparseable";
  }
  const sessionOptions = (record as { acpx?: { session_options?: unknown } } | null)?.acpx?.session_options;
  let env: unknown;
  if (sessionOptions && typeof sessionOptions === "object" && "env" in sessionOptions) {
    env = (sessionOptions as Record<string, unknown>).env;
    delete (sessionOptions as Record<string, unknown>).env;
  }
  const unredacted = JSON.stringify(record);
  record = redactRecordSecrets(record, env);
  if (env === undefined && JSON.stringify(record) === unredacted) return "unchanged";

  // Temp name does not end in `.json`, so the acpx store never lists it.
  const tempFile = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.scrub-tmp`);
  try {
    await writeFile(tempFile, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    // Skip the file if a session saved it while we were working; the next
    // start re-checks it. Saves after #290 never write `env`.
    const latest = await stat(file);
    if (latest.mtimeMs !== before.mtimeMs || latest.size !== before.size) {
      await unlink(tempFile).catch(() => undefined);
      return "failed";
    }
    await rename(tempFile, file);
    return "cleaned";
  } catch {
    await unlink(tempFile).catch(() => undefined);
    return "failed";
  }
}

export async function scrubAcpSessionEnvironments(instanceRoot: string): Promise<AcpSessionEnvScrubResult> {
  const result: AcpSessionEnvScrubResult = {
    alreadyDone: false,
    scanned: 0,
    cleaned: 0,
    unparseable: 0,
    failed: 0,
    skippedPaths: [],
  };
  const markerPath = path.join(instanceRoot, ACP_SESSION_ENV_SCRUB_MARKER);
  if (await stat(markerPath).then(() => true, () => false)) {
    result.alreadyDone = true;
    return result;
  }

  for (const file of await listSessionFiles(instanceRoot)) {
    result.scanned += 1;
    const outcome = await scrubSessionFile(file);
    if (outcome === "cleaned") result.cleaned += 1;
    if (outcome === "unparseable") result.unparseable += 1;
    if (outcome === "failed") result.failed += 1;
    if ((outcome === "unparseable" || outcome === "failed") && result.skippedPaths.length < MAX_REPORTED_PATHS) {
      result.skippedPaths.push(file);
    }
  }

  if (result.failed === 0) {
    await writeFile(
      markerPath,
      JSON.stringify({
        completedAt: new Date().toISOString(),
        scanned: result.scanned,
        cleaned: result.cleaned,
        unparseable: result.unparseable,
      }),
      { mode: 0o600 },
    ).catch(() => undefined);
  }
  return result;
}
