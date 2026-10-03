// Reads a local GS Agentic Manager database in a read-only transaction and
// prints the "Worktrees cleared" line for the 08:00 digest (GRE-452): every
// finished worktree the app removed in the last 24 hours, and where the patch
// of its uncommitted changes is. Rules are in worktree-cleanup.mjs.
//
//   pnpm metrics:worktree-cleanup [--database-url URL] [--company ID] [--now ISO] [--json]
//
// Only loopback hosts are accepted: this never reads a shared or production
// database.
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { WORKTREE_REMOVED_ACTION, formatWorktreeCleanupLine } from "./worktree-cleanup.mjs";

const root = resolve(import.meta.dirname, "../../..");
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const databaseUrl = flag("database-url", process.env.GSAM_METRICS_DATABASE_URL ?? "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip");
const companyId = flag("company");
const now = new Date(flag("now", new Date().toISOString()));

const host = new URL(databaseUrl).hostname;
if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) {
  throw new Error(`Refusing non-loopback database host ${host}; metrics run against local or test instances only.`);
}

const postgres = createRequire(join(root, "packages/db/package.json"))("postgres");
const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
const since = new Date(now.getTime() - 86_400_000);

const rows = await sql.begin("read only", (tx) => tx`
  select i.identifier as "issueIdentifier",
         a.details ->> 'worktreePath' as "worktreePath",
         a.details ->> 'branchName' as "branchName",
         a.details ->> 'patchPath' as "patchPath",
         coalesce((a.details ->> 'patchFileCount')::int, 0) as "patchFileCount"
  from activity_log a
  left join issues i on i.id::text = a.details ->> 'sourceIssueId'
  where a.action = ${WORKTREE_REMOVED_ACTION}
    and a.created_at > ${since} and a.created_at <= ${now}
    ${companyId ? sql`and a.company_id = ${companyId}` : sql``}
  order by a.created_at`);
await sql.end();

if (argv.includes("--json")) {
  console.log(JSON.stringify({ schema: "gsam.worktree-cleanup/v1", since: since.toISOString(), now: now.toISOString(), rows }, null, 2));
} else {
  console.log(formatWorktreeCleanupLine(rows));
}
