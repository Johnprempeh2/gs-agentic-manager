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
// The source is only read: a backup is one read-only transaction, so the live
// database does not need to be quiet and nothing is written under its folder.
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import {
  createDb,
  ensurePostgresDatabase,
  runDatabaseBackup,
  runDatabaseRestore,
} from "../packages/db/src/index.js";
import { ensureEmbeddedPostgres } from "../cli/src/commands/worktree.js";

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
  const rewritten = await rewritePaths(liveBackup, previewBackup, rewriteFrom, rewriteTo);
  console.log(`Pointed ${rewritten} line(s) with live data paths at the preview data folder`);

  const handle = await ensureEmbeddedPostgres(targetDbDir, 54339, { allowExisting: false });
  try {
    await ensurePostgresDatabase(`postgres://paperclip:paperclip@127.0.0.1:${handle.port}/postgres`, "paperclip");
    const targetUrl = `postgres://paperclip:paperclip@127.0.0.1:${handle.port}/paperclip`;
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
  } else {
    throw new Error("usage: greatstone-db.ts backup|seed-preview --option value ...");
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`greatstone-db: ${(error as Error).message}`);
    process.exit(1);
  },
);
