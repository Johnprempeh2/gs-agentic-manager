// Recompute stored token usage of past Codex runs from the Codex session
// rollout files (every model request is recorded there). Before the codex-acp
// turn-usage fix, ACP runs stored only the last request of each run.
// Dry run by default; pass --apply to write. Run on live only when John decides.
//   pnpm codex-run-usage:backfill [--company <id>] [--sessions-root <dir>]... [--apply]
// Default sessions root: $GSAM_HOME (or ~/.gsam)/instances. Safe to run twice.
import os from "node:os";
import path from "node:path";
import { createDb, resolveEmbeddedPostgresConnectionString } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { backfillCodexRunUsage } from "../server/src/services/codex-run-usage-backfill.js";

function flagValues(name: string): string[] {
  return process.argv.flatMap((arg, index) => {
    const value = process.argv[index + 1];
    return arg === name && value && !value.startsWith("--") ? [value] : [];
  });
}

async function main() {
  const apply = process.argv.includes("--apply");
  const roots = flagValues("--sessions-root");
  if (roots.length === 0) {
    roots.push(path.join(process.env.GSAM_HOME?.trim() || path.join(os.homedir(), ".gsam"), "instances"));
  }
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || resolveEmbeddedPostgresConnectionString({ dataDir: config.embeddedPostgresDataDir, port: config.embeddedPostgresPort });

  console.log(`${apply ? "APPLY" : "DRY RUN"}: reading Codex session rollouts under ${roots.join(", ")}`);
  const result = await backfillCodexRunUsage(createDb(dbUrl), {
    sessionsRoots: roots,
    companyId: flagValues("--company")[0] ?? null,
    apply,
    log: (line) => console.log(line),
  });
  console.log(
    `\n${result.runs} Codex runs, ${result.rollouts} rollouts: ${result.changed} ${apply ? "updated" : "would change"},`
    + ` ${result.unchanged} already correct, ${result.alreadyBackfilled} already backfilled,`
    + ` ${result.noRollout} without a rollout file, ${result.noRequestsInWindow} with no request in their time window,`
    + ` ${result.noUsage} without usage.`,
  );
  if (result.changed > 0) console.log(`Input plus output tokens of changed runs: ${result.tokens.before} -> ${result.tokens.after}.`);
  if (!apply) console.log("Nothing written. Re-run with --apply to update.");
}

void main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`Codex run usage backfill failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
