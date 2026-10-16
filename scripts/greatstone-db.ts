// Database steps for scripts/greatstone-preview.sh and scripts/greatstone-release.sh.
//
//   greatstone-db.ts backup --source-url <url> --dir <dir> --prefix <name>
//     Writes a gzipped SQL backup of <url> into <dir> and prints its path.
//
//   greatstone-db.ts seed-preview --source-url <url> --target-db-dir <dir> --work-dir <dir>
//                                 --rewrite-from <live data dir> --rewrite-to <preview data dir>
//     Copies the live database into a new embedded PostgreSQL cluster for the
//     preview, then turns off everything that could act outside the preview.
//
//   greatstone-db.ts blocking-cycles --source-url <url> [--remove <relation id>]
//     Lists tasks whose "blocked by" links form a loop, with the id of each
//     link. With --remove, deletes that one link and logs it in the activity
//     log. See scripts/greatstone-blocking-cycles.sh.
//
//   greatstone-db.ts restore-legacy-password --data-dir <live db dir>
//     Rollback to a release from before GRE-930 only: puts the database role
//     back on the old fixed password and moves the random password file aside,
//     so the older server can log in. Starts the cluster for the change if it
//     is not running, and stops it again after.
//
// The source is only read: a backup is one read-only transaction, so the live
// database does not need to be quiet and nothing is written under its folder.
import { createReadStream, createWriteStream, existsSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import {
  createDb,
  embeddedPostgresConnectionString,
  ensurePostgresDatabase,
  readEmbeddedPostgresPassword,
  restoreLegacyEmbeddedPostgresPassword,
  runDatabaseBackup,
  runDatabaseRestore,
} from "../packages/db/src/index.js";
import { ensureEmbeddedPostgres } from "../cli/src/commands/worktree.js";
import { findBlockingCycles } from "./blocking-cycles-lib.mjs";

// Each statement stops one way the copied data could act outside the preview.
// A table or column that an older schema does not have is reported and skipped.
const PREVIEW_GUARDS: Array<{ label: string; sql: string }> = [
  {
    label: "workspace runtime services stopped",
    sql: `update workspace_runtime_services set status = 'stopped', url = null, port = null where status <> 'stopped'`,
  },
  {
    label: "project workspace runtimes set to stopped",
    sql: `update project_workspaces set metadata = jsonb_set(metadata, '{runtimeConfig,desiredState}', '"stopped"')
          where metadata->'runtimeConfig'->>'desiredState' = 'running'`,
  },
  {
    label: "execution workspace runtimes set to stopped",
    sql: `update execution_workspaces set metadata = jsonb_set(metadata, '{config,desiredState}', '"stopped"')
          where metadata->'config'->>'desiredState' = 'running'`,
  },
  {
    label: "tool action requests cancelled",
    sql: `update tool_action_requests set status = 'cancelled' where status in ('pending', 'approved', 'executing')`,
  },
  {
    label: "tool connections disabled",
    sql: `update tool_connections set enabled = false where enabled`,
  },
  {
    label: "chat endpoints paused",
    sql: `update chat_endpoints set status = 'paused' where status in ('active', 'verifying', 'attention')`,
  },
  {
    label: "plugins disabled",
    sql: `update plugins set status = 'disabled' where status in ('installed', 'ready', 'upgrade_pending')`,
  },
  {
    label: "environment lease cleanups dropped",
    sql: `update environment_leases set status = 'failed' where status = 'pending_cleanup'`,
  },
];

function parseArgs(argv: string[]): { command: string; options: Record<string, string> } {
  const [command = "", ...rest] = argv;
  const options: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`bad argument near ${key ?? "<end>"}`);
    }
    options[key.slice(2)] = value;
  }
  return { command, options };
}

function required(options: Record<string, string>, key: string): string {
  const value = options[key];
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

async function backup(sourceUrl: string, dir: string, prefix: string): Promise<string> {
  const result = await runDatabaseBackup({
    connectionString: sourceUrl,
    backupDir: dir,
    retention: { dailyDays: 3650, weeklyWeeks: 520, monthlyMonths: 120 },
    filenamePrefix: prefix,
    backupEngine: "javascript",
  });
  return result.backupFile;
}

// Rewrites absolute paths into the live data folder (agent instruction files,
// workspaces) so that the preview reads and writes its own copy.
async function rewritePaths(inputFile: string, outputFile: string, from: string, to: string): Promise<number> {
  const fromPrefix = from.endsWith("/") ? from : `${from}/`;
  const toPrefix = to.endsWith("/") ? to : `${to}/`;
  let rewritten = 0;
  const lines = createInterface({
    input: createReadStream(inputFile).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  async function* rewrite() {
    for await (const line of lines) {
      if (line.includes(fromPrefix)) {
        rewritten += 1;
        yield `${line.split(fromPrefix).join(toPrefix)}\n`;
      } else {
        yield `${line}\n`;
      }
    }
  }
  await pipeline(Readable.from(rewrite()), createGzip(), createWriteStream(outputFile));
  return rewritten;
}

async function seedPreview(options: Record<string, string>): Promise<void> {
  const sourceUrl = required(options, "source-url");
  const targetDbDir = path.resolve(required(options, "target-db-dir"));
  const workDir = path.resolve(required(options, "work-dir"));
  const rewriteFrom = path.resolve(required(options, "rewrite-from"));
  const rewriteTo = path.resolve(required(options, "rewrite-to"));

  if (targetDbDir.startsWith(`${rewriteFrom}/`)) {
    throw new Error(`refusing to seed into the live data folder (${targetDbDir})`);
  }
  if (existsSync(path.join(targetDbDir, "PG_VERSION"))) {
    throw new Error(`${targetDbDir} already holds a database; remove the preview data first`);
  }

  const liveBackup = await backup(sourceUrl, workDir, "live-copy");
  console.log(`Copied the live database: ${liveBackup}`);
  const previewBackup = path.join(workDir, "preview-seed.sql.gz");
  // Written beside it and renamed into place, so preview-seed.sql.gz is only
  // ever whole: a run that is stopped half way leaves the .tmp, not a short seed.
  const partial = `${previewBackup}.${process.pid}.tmp`;
  let rewritten: number;
  try {
    rewritten = await rewritePaths(liveBackup, partial, rewriteFrom, rewriteTo);
    renameSync(partial, previewBackup);
  } finally {
    rmSync(partial, { force: true });
  }
  console.log(`Pointed ${rewritten} line(s) with live data paths at the preview data folder`);

  const handle = await ensureEmbeddedPostgres(targetDbDir, 54339, { allowExisting: false });
  try {
    await ensurePostgresDatabase(embeddedPostgresConnectionString({ ...handle, database: "postgres" }), "paperclip");
    const targetUrl = embeddedPostgresConnectionString(handle);
    await runDatabaseRestore({ connectionString: targetUrl, backupFile: previewBackup });
    console.log("Restored the copy into the preview database");

    const db = createDb(targetUrl);
    try {
      for (const guard of PREVIEW_GUARDS) {
        try {
          const result = await db.$client.unsafe(guard.sql);
          console.log(`  guard: ${guard.label}: ${result.count}`);
        } catch (error) {
          console.log(`  guard: ${guard.label}: skipped (${(error as Error).message})`);
        }
      }
    } finally {
      await db.$client.end({ timeout: 5 });
    }
  } finally {
    await handle.stop();
  }
}

async function restoreLegacyPassword(options: Record<string, string>): Promise<void> {
  const dataDir = path.resolve(required(options, "data-dir"));
  if (!readEmbeddedPostgresPassword(dataDir)) {
    console.log("The database has no random password file; nothing to change.");
    return;
  }
  // Reuses the running cluster, or starts it just for this change.
  const handle = await ensureEmbeddedPostgres(dataDir, 54329);
  try {
    const status = await restoreLegacyEmbeddedPostgresPassword({ dataDir, port: handle.port });
    console.log(
      status === "restored"
        ? "Put the database back on the old fixed password for the older release."
        : "The database was already on the old fixed password; moved the password file aside.",
    );
  } finally {
    if (handle.startedByThisProcess) await handle.stop();
  }
}

async function blockingCycles(options: Record<string, string>): Promise<void> {
  const db = createDb(required(options, "source-url"));
  try {
    const removeId = options.remove;
    if (removeId) {
      const removed = await db.$client.begin(async (tx) => {
        const rows = await tx.unsafe(
          `delete from issue_relations where id = $1 and type = 'blocks'
           returning id, company_id, issue_id, related_issue_id`,
          [removeId],
        );
        const row = rows[0];
        if (!row) return null;
        await tx.unsafe(
          `insert into activity_log (company_id, actor_type, actor_id, action, entity_type, entity_id, details)
           values ($1, 'system', 'blocking-cycle-repair', 'issue.blockers_updated', 'issue', $2, $3::jsonb)`,
          [row.company_id, row.related_issue_id, JSON.stringify({ removedBlockerIssueId: row.issue_id, reason: "blocking cycle repair" })],
        );
        return row;
      });
      console.log(removed ? `Removed link ${removeId}.` : `No blocking link with id ${removeId}; nothing changed.`);
    }

    const edges = await db.$client.unsafe(
      `select r.id, r.company_id as "companyId", r.issue_id as "blockerIssueId", r.related_issue_id as "blockedIssueId"
       from issue_relations r where r.type = 'blocks'`,
    );
    const cycles = findBlockingCycles(edges as unknown as Parameters<typeof findBlockingCycles>[0]);
    if (cycles.length === 0) {
      console.log("No blocking cycles.");
      return;
    }
    const issueIds = [...new Set(cycles.flatMap((cycle) => cycle.issueIds))];
    const labels = new Map<string, string>();
    for (const row of await db.$client.unsafe(
      `select id, coalesce(identifier, id::text) as label, title, status from issues where id = any($1::uuid[])`,
      [issueIds],
    )) {
      labels.set(row.id as string, `${row.label} "${row.title}" (${row.status})`);
    }
    console.log(`${cycles.length} blocking cycle(s). Remove one link per cycle with --remove <link id>.`);
    for (const [n, cycle] of cycles.entries()) {
      console.log(`\nCycle ${n + 1}, company ${cycle.companyId}:`);
      for (const edge of cycle.edges) {
        console.log(`  link ${edge.id}: ${labels.get(edge.blockerIssueId)} blocks ${labels.get(edge.blockedIssueId)}`);
      }
    }
    process.exitCode = 3;
  } finally {
    await db.$client.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "backup") {
    const file = await backup(
      required(options, "source-url"),
      path.resolve(required(options, "dir")),
      required(options, "prefix"),
    );
    console.log(file);
  } else if (command === "seed-preview") {
    await seedPreview(options);
  } else if (command === "blocking-cycles") {
    await blockingCycles(options);
  } else if (command === "restore-legacy-password") {
    await restoreLegacyPassword(options);
  } else {
    throw new Error("usage: greatstone-db.ts backup|seed-preview|blocking-cycles|restore-legacy-password --option value ...");
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    console.error(`greatstone-db: ${(error as Error).message}`);
    process.exit(1);
  },
);
