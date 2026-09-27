// Reads a local GS Agentic Manager database in a read-only transaction and
// saves the time lost to platform faults (L1–L4, GRE-37) under
// .lifecycle-baseline/metrics/lost-time/<stamp>/.
//
//   pnpm metrics:lost-time [--database-url URL] [--company ID] [--window-days 7] [--since ISO] [--now ISO] [--silence-minutes 20] [--out DIR]
//
// The database URL defaults to $GSAM_METRICS_DATABASE_URL, then the embedded
// local instance. Only loopback hosts are accepted: this never reads a shared
// or production database.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_SILENCE_MINUTES, computeLostTime } from "./lost-time.mjs";

const root = resolve(import.meta.dirname, "../../..");
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const databaseUrl = flag("database-url", process.env.GSAM_METRICS_DATABASE_URL ?? "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip");
const companyId = flag("company");
const windowDays = Number(flag("window-days", "7"));
const now = new Date(flag("now", new Date().toISOString()));
const sinceFlag = flag("since");
const silenceMinutes = Number(flag("silence-minutes", String(DEFAULT_SILENCE_MINUTES)));
const outFlag = flag("out");

const host = new URL(databaseUrl).hostname;
if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) {
  throw new Error(`Refusing non-loopback database host ${host}; metrics run against local or test instances only.`);
}

const postgres = createRequire(join(root, "packages/db/package.json"))("postgres");
const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
const since = sinceFlag ? new Date(sinceFlag) : new Date(now.getTime() - windowDays * 86_400_000);
const scope = (column) => (companyId ? sql`and ${sql(column)} = ${companyId}` : sql``);

const snapshot = await sql.begin("read only", async (tx) => {
  const runs = await tx`
    select r.id, r.agent_id as "agentId", r.status, r.error_code as "errorCode",
      r.created_at as "createdAt", r.started_at as "startedAt", r.finished_at as "finishedAt",
      i.identifier as "issueIdentifier"
    from heartbeat_runs r left join issues i on i.id::text = coalesce(r.context_snapshot->>'issueId', r.context_snapshot->>'taskId')
    where r.finished_at >= ${since} and r.finished_at <= ${now} ${scope("r.company_id")}`;
  const activity = await tx`
    select a.actor_type as "actorType", a.entity_id as "entityId", a.created_at as "createdAt",
      a.details->>'status' as status, a.details->>'source' as source, a.details->>'previousStatus' as "previousStatus",
      i.identifier as "issueIdentifier"
    from activity_log a left join issues i on i.id::text = a.entity_id
    where a.entity_type = 'issue' and a.action = 'issue.updated' and a.actor_type = 'system'
      and a.created_at >= ${since} and a.created_at <= ${now} ${scope("a.company_id")}`;
  const interactions = await tx`
    select id, issue_id::text as "issueId", kind, status, created_at as "createdAt", resolved_at as "resolvedAt"
    from issue_thread_interactions where created_at <= ${now} ${scope("company_id")}`;
  const comments = await tx`
    select c.id, c.issue_id::text as "issueId", c.author_user_id as "authorUserId", c.body, c.created_at as "createdAt",
      i.identifier as "issueIdentifier"
    from issue_comments c join issues i on i.id = c.issue_id
    where c.author_user_id is not null and c.deleted_at is null
      and c.created_at >= ${since} and c.created_at <= ${now} ${scope("c.company_id")}`;
  return { now, runs, activity, interactions, comments };
});
await sql.end();

const metrics = computeLostTime(snapshot, { now, windowDays, since: sinceFlag ? since : null, silenceMinutes });
const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout.trim();
const report = {
  schema: "gsam.lost-time/v1",
  measuredAt: new Date().toISOString(),
  windowStart: metrics.windowStart,
  windowEnd: now.toISOString(),
  source: { host, database: new URL(databaseUrl).pathname.slice(1), companyId: companyId ?? "all" },
  commit: git("rev-parse", "HEAD"),
  ...metrics,
};

const { totals, l1HungRuns: l1, l2FalseStalls: l2, l3ReassignCancels: l3, l4HumanComments: l4 } = metrics;
const pct = (value) => (value == null ? "n/a" : `${value}%`);
const runLine = (run) => `- ${run.issueIdentifier ?? "no issue"} · run \`${run.id.slice(0, 8)}\` · ${run.status}/${run.errorCode ?? "-"} · ${run.minutes} min`;
const markdown = [
  "# Time lost to platform faults — L1 to L4",
  "",
  `Window: ${report.windowStart} to ${report.windowEnd} · source ${host} (${report.source.companyId}) · commit \`${report.commit.slice(0, 9)}\``,
  `Denominator: ${totals.finishedRuns} runs finished, ${totals.agentMinutes} agent-minutes.`,
  "",
  "| # | Number | Value | Detail |",
  "|---|---|---:|---|",
  `| L1 | Runs stopped as silent or hung | ${l1.count} | ${l1.caughtByWatchdog.count} by a watchdog, ${l1.caughtByHuman.count} cancelled by a person after ≥ ${l1.silenceMinutes} min |`,
  `| L1 | Minutes in those runs | ${l1.minutes} | ${pct(l1.shareOfAgentMinutesPct)} of agent-minutes; longest ${Math.max(l1.caughtByWatchdog.maxMinutes, l1.caughtByHuman.maxMinutes)} min |`,
  `| L2 | Recovery moved to \`blocked\` while an interaction was pending | ${l2.count} | of ${l2.recoveryBlocks} recovery moves to \`blocked\` |`,
  `| L3 | Runs cancelled by \`issue_reassigned\` | ${l3.count} | ${l3.overFiveMinutes} ran ≥ 5 min |`,
  `| L3 | Minutes in those runs | ${l3.minutes} | ${pct(l3.shareOfAgentMinutesPct)} of agent-minutes; longest ${l3.maxMinutes} min |`,
  `| L4 | Human comments that ask for or relay status, or recover a run | ${l4.count} | of ${l4.humanComments} human comments; ask ${l4.byRule.asksStatus}, relay ${l4.byRule.relaysStatus}, recover ${l4.byRule.recoversRun} |`,
  "",
  "## L1 runs",
  "",
  ...([...l1.caughtByWatchdog.runs, ...l1.caughtByHuman.runs].map(runLine).join("\n") || "None.").split("\n"),
  "",
  "## L2 false stalls",
  "",
  ...(l2.falseStalls.length
    ? l2.falseStalls.map((row) => `- ${row.issueIdentifier} at ${new Date(row.movedAt).toISOString()} (${row.source}, from ${row.previousStatus}); pending ${row.pendingInteractions.map((entry) => `${entry.kind} \`${entry.id.slice(0, 8)}\``).join(", ")}`)
    : ["None."]),
  "",
  "## L3 runs",
  "",
  ...(l3.runs.length ? l3.runs.map(runLine) : ["None."]),
  "",
  "## L4 comments",
  "",
  ...(l4.comments.length
    ? l4.comments.map((comment) => `- ${comment.issueIdentifier} ${new Date(comment.createdAt).toISOString().slice(0, 16)} [${comment.rules.join(", ")}] comment \`${String(comment.id).slice(0, 8)}\``)
    : ["None."]),
  "",
].join("\n");

const stamp = report.measuredAt.replaceAll(":", "-");
const outDir = outFlag ? resolve(outFlag) : join(root, ".lifecycle-baseline", "metrics", "lost-time", stamp);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "lost-time.json"), JSON.stringify(report, null, 2) + "\n");
writeFileSync(join(outDir, "lost-time.md"), markdown);
console.log(markdown);
console.log(`Saved ${join(outDir, "lost-time.json")}`);
