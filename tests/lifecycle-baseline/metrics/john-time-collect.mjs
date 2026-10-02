// Reads a local GS Agentic Manager database in a read-only transaction and
// prints the "John's time" line for the 08:00 digest (GRE-397): Chase,
// Unstick, Decisions and Failed runs for the last 24 hours, plus the 7-day
// trend. Rules are in john-time.mjs.
//
//   pnpm metrics:john-time [--database-url URL] [--company ID] [--now ISO] [--john-user-ids a,b] [--json]
//
// John's user ids default to every signed-in user plus the `local-board`
// sentinel (this is a one-person board); pass --john-user-ids to narrow it.
// Only loopback hosts are accepted: this never reads a shared or production
// database. Output never carries comment bodies, only ids.
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { computeJohnTime, formatDigestLine } from "./john-time.mjs";

const root = resolve(import.meta.dirname, "../../..");
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const databaseUrl = flag("database-url", process.env.GSAM_METRICS_DATABASE_URL ?? "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip");
const companyId = flag("company");
const now = new Date(flag("now", new Date().toISOString()));
const johnFlag = flag("john-user-ids");
const days = 7;

const host = new URL(databaseUrl).hostname;
if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) {
  throw new Error(`Refusing non-loopback database host ${host}; metrics run against local or test instances only.`);
}

const postgres = createRequire(join(root, "packages/db/package.json"))("postgres");
const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
const since = new Date(now.getTime() - days * 86_400_000);
const scope = (column) => (companyId ? sql`and ${sql(column)} = ${companyId}` : sql``);

const snapshot = await sql.begin("read only", async (tx) => {
  const johnUserIds = johnFlag ? johnFlag.split(",").map((id) => id.trim()).filter(Boolean) : ["local-board", ...(await tx`select id from "user"`).map((row) => row.id)];
  const comments = await tx`
    select c.id, c.author_user_id as "authorUserId", c.body, c.created_at as "createdAt", i.identifier as "issueIdentifier"
    from issue_comments c join issues i on i.id = c.issue_id
    where c.author_type = 'user' and c.author_user_id in ${sql(johnUserIds)} and c.deleted_at is null
      and c.created_at > ${since} and c.created_at <= ${now} ${scope("c.company_id")}`;
  const interactions = await tx`
    select status, resolved_by_user_id as "resolvedByUserId", resolved_at as "resolvedAt"
    from issue_thread_interactions where resolved_at > ${since} and resolved_at <= ${now} ${scope("company_id")}`;
  const approvals = await tx`
    select status, decided_by_user_id as "decidedByUserId", decided_at as "decidedAt"
    from approvals where decided_at > ${since} and decided_at <= ${now} ${scope("company_id")}`;
  const runs = await tx`
    select status, error_code as "errorCode", finished_at as "finishedAt"
    from heartbeat_runs where finished_at > ${since} and finished_at <= ${now} ${scope("company_id")}`;
  return { johnUserIds, comments, interactions, approvals, runs };
});
await sql.end();

const report = computeJohnTime(snapshot, { now, days });
if (argv.includes("--json")) {
  console.log(JSON.stringify({ schema: "gsam.john-time/v1", measuredAt: new Date().toISOString(), source: { host, companyId: companyId ?? "all" }, ...report }, null, 2));
} else {
  console.log(formatDigestLine(report));
}
