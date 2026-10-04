import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

// ACP session records saved before #290 hold the run environment (API keys,
// git tokens, provider keys) in `acpx.session_options.env`. #290 stops new
// saves and strips `env` when a record is saved again, but records that are
// never resumed keep it forever (GRE-510). This one-time startup scrub removes
// the field from every record on disk. A marker file makes later starts skip
// the walk; the marker is written only when no file failed, so a failed write
// is retried on the next start.

export const ACP_SESSION_ENV_SCRUB_MARKER = ".acp-session-env-scrub-v1.json";
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
  // Cheap pre-check: a record without the key needs no parse.
  if (!text.includes("\"env\"")) return "unchanged";

  let record: unknown;
  try {
    record = JSON.parse(text);
  } catch {
    return "unparseable";
  }
  const sessionOptions = (record as { acpx?: { session_options?: unknown } } | null)?.acpx?.session_options;
  if (!sessionOptions || typeof sessionOptions !== "object" || !("env" in sessionOptions)) return "unchanged";
  delete (sessionOptions as Record<string, unknown>).env;

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
