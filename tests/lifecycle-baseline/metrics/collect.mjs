// Reads a local GS Agentic Manager database in a read-only transaction and
// saves R1, R2 and S1 under .lifecycle-baseline/metrics/<stamp>/.
//
//   pnpm metrics:collect [--database-url URL] [--company ID] [--window-days 7] [--now ISO]
//
// The database URL defaults to $GSAM_METRICS_DATABASE_URL, then the embedded
// local instance. Only loopback hosts are accepted: this never reads a shared
// or production database.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { computeAll } from "./compute.mjs";

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
const outFlag = flag("out");

const host = new URL(databaseUrl).hostname;
if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) {
  throw new Error(`Refusing non-loopback database host ${host}; metrics run against local or test instances only.`);
}

const postgres = createRequire(join(root, "packages/db/package.json"))("postgres");
const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
const since = new Date(now.getTime() - windowDays * 86_400_000);
const scope = (column) => (companyId ? sql`and ${sql(column)} = ${companyId}` : sql``);

const snapshot = await sql.begin("read only", async (tx) => {
  const issues = await tx`
    select id, company_id as "companyId", identifier, parent_id as "parentId", status,
      assignee_agent_id as "assigneeAgentId", assignee_user_id as "assigneeUserId",
      monitor_next_check_at as "monitorNextCheckAt", hidden_at as "hiddenAt",
      updated_at as "updatedAt", completed_at as "completedAt"
    from issues where true ${scope("company_id")}`;
  const runs = await tx`
    select r.id, r.company_id as "companyId", r.agent_id as "agentId", r.status,
      r.context_snapshot->>'issueId' as "issueId", r.error_code as "errorCode",
      r.created_at as "createdAt", r.started_at as "startedAt", r.finished_at as "finishedAt",
      w.requested_at as "wakeRequestedAt",
      (select max(e.created_at) from heartbeat_run_events e
        where e.run_id = r.id and e.event_type = 'run.phase.timing' and e.payload->>'phase' = 'prepare_turn') as "promptSentAt"
    from heartbeat_runs r left join agent_wakeup_requests w on w.id = r.wakeup_request_id
    where (r.finished_at is null or r.finished_at >= ${since} or r.created_at >= ${since}) ${scope("r.company_id")}`;
  const activity = await tx`
    select actor_type as "actorType", action, entity_type as "entityType", entity_id as "entityId",
      run_id as "runId", created_at as "createdAt"
    from activity_log where created_at >= ${since} ${scope("company_id")}`;
  const wakeRequests = await tx`
    select status, payload->>'issueId' as "issueId" from agent_wakeup_requests
    where status in ('queued', 'deferred_issue_execution') ${scope("company_id")}`;
  const interactions = await tx`
    select issue_id as "issueId", status from issue_thread_interactions where status = 'pending' ${scope("company_id")}`;
  const approvals = await tx`
    select ia.issue_id as "issueId", a.status from issue_approvals ia join approvals a on a.id = ia.approval_id
    where a.status in ('pending', 'revision_requested') ${scope("ia.company_id")}`;
  const recoveryActions = await tx`
    select source_issue_id as "sourceIssueId", resolved_at as "resolvedAt" from issue_recovery_actions
    where resolved_at is null ${scope("company_id")}`;
  const treeHolds = await tx`
    select root_issue_id as "rootIssueId", status from issue_tree_holds where status = 'active' ${scope("company_id")}`;
  const relations = await tx`
    select issue_id as "blockerIssueId", related_issue_id as "blockedIssueId" from issue_relations
    where type = 'blocks' ${scope("company_id")}`;
  const agents = await tx`
    select id, status, coalesce((runtime_config->'heartbeat'->>'enabled')::boolean, false) as "timerHeartbeat"
    from agents where true ${scope("company_id")}`;
  return { now, issues, runs, activity, wakeRequests, interactions, approvals, recoveryActions, treeHolds, relations, agents };
});
await sql.end();

const metrics = computeAll(snapshot, { now, windowDays });
const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout.trim();
const report = {
  schema: "gsam.metrics/v1",
  measuredAt: new Date().toISOString(),
  windowEnd: now.toISOString(),
  windowDays,
  source: { host, database: new URL(databaseUrl).pathname.slice(1), companyId: companyId ?? "all" },
  commit: git("rev-parse", "HEAD"),
  ...metrics,
};

const fmt = (value, unit = "") => (value == null ? "n/a" : `${Math.round(value)}${unit}`);
const pct = (value) => (value == null ? "n/a" : `${(value * 100).toFixed(1)}%`);
const markdown = [
  "# Tracked numbers — R1, R2, S1",
  "",
  `Window: ${windowDays} days ending ${report.windowEnd} · source ${host} (${report.source.companyId}) · commit \`${report.commit.slice(0, 9)}\``,
  "",
  "| # | Number | Value | Sample |",
  "|---|---|---:|---|",
  `| R1 | Stranded task trees stopped in window | ${metrics.r1.weekly} | ${metrics.r1.treesWithOpenWork} trees with open work; ${metrics.r1.total} stranded in total |`,
  `| R2 | Run failure rate | ${pct(metrics.r2.failureRate)} | ${metrics.r2.failed} failed / ${metrics.r2.succeeded + metrics.r2.failed} finished (${metrics.r2.cancelled} cancelled, excluded) |`,
  `| R2 | Failures recovered without a human | ${pct(metrics.r2.unattendedRecoveryShare)} | ${metrics.r2.recoveredWithoutHuman} auto, ${metrics.r2.recoveredWithHuman} human, ${metrics.r2.unresolved} unresolved, ${metrics.r2.failedWithoutIssue} without issue |`,
  `| S1 | Wake → first useful action, median | ${fmt(metrics.s1.medianMs, " ms")} | n=${metrics.s1.sampleSize} (${metrics.s1.runsWithoutUsefulAction} runs without a useful action) |`,
  `| S1 | Wake → first useful action, p95 | ${fmt(metrics.s1.p95Ms, " ms")} | n=${metrics.s1.sampleSize}; queue delay median ${fmt(metrics.s1.queueDelayMedianMs, " ms")} |`,
  `| S1 | of which setup (wake → prompt sent), median | ${fmt(metrics.s1.split.setupMedianMs, " ms")} | n=${metrics.s1.split.sampleSize}; p95 ${fmt(metrics.s1.split.setupP95Ms, " ms")} |`,
  `| S1 | of which agent (prompt sent → first useful action), median | ${fmt(metrics.s1.split.agentMedianMs, " ms")} | n=${metrics.s1.split.sampleSize}; p95 ${fmt(metrics.s1.split.agentP95Ms, " ms")} |`,
  "",
  "## Stranded trees",
  "",
  ...(metrics.r1.stranded.length
    ? metrics.r1.stranded.map((tree) => `- ${tree.rootIdentifier ?? tree.rootIssueId}: ${tree.openIssues.map((issue) => `${issue.identifier} (${issue.status})`).join(", ")}; last activity ${tree.lastActivityAt}`)
    : ["None."]),
  "",
].join("\n");

const stamp = report.measuredAt.replaceAll(":", "-");
const outDir = outFlag ? resolve(outFlag) : join(root, ".lifecycle-baseline", "metrics", stamp);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "metrics.json"), JSON.stringify(report, null, 2) + "\n");
writeFileSync(join(outDir, "metrics.md"), markdown);
// Stable path read by the weekly budget check (tests/metrics-budgets/budgets.json).
if (!outFlag) writeFileSync(join(root, ".lifecycle-baseline", "metrics", "latest.json"), JSON.stringify(report, null, 2) + "\n");
console.log(markdown);
console.log(`Saved ${join(outDir, "metrics.json")}`);
