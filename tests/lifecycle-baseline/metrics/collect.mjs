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
      conversation_user_id as "conversationUserId", conversation_state as "conversationState",
      monitor_next_check_at as "monitorNextCheckAt", monitor_wake_requested_at as "monitorWakeRequestedAt", hidden_at as "hiddenAt",
      execution_run_id as "executionRunId", execution_policy as "executionPolicy", updated_at as "updatedAt", completed_at as "completedAt"
    from issues where true ${scope("company_id")}`;
  const runs = await tx`
    select r.id, r.company_id as "companyId", r.agent_id as "agentId", r.status,
      r.context_snapshot->>'issueId' as "issueId", r.context_snapshot->>'taskId' as "taskId",
      r.native_issue_id as "nativeIssueId", r.error_code as "errorCode",
      coalesce(r.error ilike '%terminal access failure%', false) as "errorMentionsAccessFailure",
      case when r.status in ('failed', 'timed_out', 'interrupted') then left(r.error, 2000) end as "errorText",
      r.retry_of_run_id as "retryOfRunId",
      r.created_at as "createdAt", r.started_at as "startedAt", r.last_output_at as "lastOutputAt", r.finished_at as "finishedAt",
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
    select status, reason, requested_at as "requestedAt", payload->>'issueId' as "issueId", payload->>'taskId' as "taskId",
      payload->'_paperclipWakeContext'->>'issueId' as "contextIssueId",
      payload->'_paperclipWakeContext'->>'taskId' as "contextTaskId"
    from agent_wakeup_requests
    where status in ('queued', 'deferred_issue_execution', 'claimed') ${scope("company_id")}`;
  const interactions = await tx`
    select issue_id as "issueId", status from issue_thread_interactions where status = 'pending' ${scope("company_id")}`;
  const approvals = await tx`
    select ia.issue_id as "issueId", a.status from issue_approvals ia join approvals a on a.id = ia.approval_id
    where a.status in ('pending', 'revision_requested') ${scope("ia.company_id")}`;
  const recoveryActions = await tx`
    select source_issue_id as "sourceIssueId", resolved_at as "resolvedAt", status, owner_type as "ownerType",
      cause, evidence->'automaticRecovery'->>'replay' as replay
    from issue_recovery_actions
    where (resolved_at is null or evidence->'automaticRecovery'->>'replay' = 'blocked') ${scope("company_id")}`;
  const treeHolds = await tx`
    select root_issue_id as "rootIssueId", status from issue_tree_holds where status = 'active' ${scope("company_id")}`;
  const relations = await tx`
    select issue_id as "blockerIssueId", related_issue_id as "blockedIssueId" from issue_relations
    where type = 'blocks' ${scope("company_id")}`;
  const agents = await tx`
    select id, name, status, coalesce((runtime_config->'heartbeat'->>'enabled')::boolean, false) as "timerHeartbeat"
    from agents where true ${scope("company_id")}`;
  const retryExhaustions = await tx`
    select e.run_id as "runId", e.created_at as "createdAt" from heartbeat_run_events e
    where e.message like 'Bounded retry exhausted%' and e.created_at >= ${since} ${scope("e.company_id")}`;
  // Row 76 (GRE-725): disposition repair escalations and the repair runs behind them.
  const repairEscalations = await tx`
    select entity_id as "issueId", created_at as "createdAt", details->>'identifier' as identifier,
      details->>'terminalReason' as "terminalReason", details->>'recoveryActionId' as "recoveryActionId",
      details->>'sourceStateFingerprint' as fingerprint, details->'sourceAssigneeBefore' as "sourceAssigneeBefore"
    from activity_log
    where action = 'issue.disposition_repair_escalated' and created_at >= ${since} ${scope("company_id")}`;
  const repairRuns = await tx`
    select r.id, r.context_snapshot->>'issueId' as "issueId", r.created_at as "createdAt",
      r.context_snapshot->>'dispositionRepairFingerprint' as fingerprint,
      (select count(*)::int from activity_log a
        where a.run_id = r.id and a.actor_type = 'agent' and a.action = 'issue.comment_added') as "commentCount"
    from heartbeat_runs r
    where r.context_snapshot->>'wakeReason' = 'issue_disposition_repair'
      and r.context_snapshot->>'issueId' in (
        select entity_id from activity_log
        where action = 'issue.disposition_repair_escalated' and created_at >= ${since} ${scope("company_id")})
      ${scope("r.company_id")}`;
  // Row 126 (GRE-893): wakes the rewake throttle skipped.
  const throttledWakes = await tx`
    select agent_id as "agentId", reason, requested_at as "requestedAt", payload->>'issueId' as "issueId",
      (payload->'heartbeatSkip'->>'noProgressStreak')::int as "noProgressStreak",
      payload->'heartbeatSkip'->>'requestedReason' as "requestedReason"
    from agent_wakeup_requests
    where status = 'skipped' and reason = 'issue_rewake_throttled' and requested_at >= ${since} ${scope("company_id")}`;
  return { now, issues, runs, activity, wakeRequests, retryExhaustions, interactions, approvals, recoveryActions, treeHolds, relations, agents, repairEscalations, repairRuns, throttledWakes };
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
  `| R1 | Parked wakes on an issue with no live run, older than ${metrics.parkedWakes.minAgeMinutes} min | ${metrics.parkedWakes.total} | ${metrics.parkedWakes.byReason.length ? `top reasons: ${metrics.parkedWakes.byReason.slice(0, 5).map((entry) => `${entry.reason} ${entry.count}`).join(", ")}` : "none"} |`,
  `| R1 | Throttled rewakes (skipped, ${windowDays} days) | ${metrics.throttledRewakes.total} | ${metrics.throttledRewakes.issues} issue/agent pairs; highest streak ${metrics.throttledRewakes.maxStreak} |`,
  `| R2 | Platform failure rate | ${pct(metrics.r2.platformFailureRate)} | ${metrics.r2.platformFailed} failed / ${metrics.r2.platformFinished} finished, rejected logins and account refusals left out (all-in ${pct(metrics.r2.failureRate)}; ${metrics.r2.cancelled} cancelled, excluded) |`,
  `| R2 | Login refusals (count) | ${metrics.r2.loginRefusals} | ${metrics.auth.retriesAfterAuthFailure} retries after them; ${metrics.auth.retryExhaustionsFromAuthFailures} of ${metrics.auth.retryExhaustions} \`Bounded retry exhausted\` events follow one |`,
  `| R2 | Account and setup refusals (count) | ${metrics.r2.accountRefusals} | ${Object.entries(metrics.r2.accountRefusalsByReason).map(([reason, count]) => `${reason} ${count}`).join(", ")} |`,
  `| R2 | Failures recovered without a human | ${pct(metrics.r2.unattendedRecoveryShare)} | ${metrics.r2.recoveredWithoutHuman} auto, ${metrics.r2.recoveredWithHuman} human, ${metrics.r2.unresolved} unresolved, ${metrics.r2.failedWithoutIssue} without issue |`,
  `| S1 | Wake → first useful action, median | ${fmt(metrics.s1.medianMs, " ms")} | n=${metrics.s1.sampleSize} (${metrics.s1.runsWithoutUsefulAction} runs without a useful action) |`,
  `| S1 | Wake → first useful action, p95 | ${fmt(metrics.s1.p95Ms, " ms")} | n=${metrics.s1.sampleSize}; queue delay median ${fmt(metrics.s1.queueDelayMedianMs, " ms")} |`,
  `| S1-work | Wake → first useful non-comment action, median | ${fmt(metrics.s1.work.medianMs, " ms")} | n=${metrics.s1.work.sampleSize} (${metrics.s1.work.runsWithCommentsOnly} timed runs only commented) |`,
  `| S1-work | Wake → first useful non-comment action, p95 | ${fmt(metrics.s1.work.p95Ms, " ms")} | n=${metrics.s1.work.sampleSize} |`,
  `| S1 | of which setup (wake → prompt sent), median | ${fmt(metrics.s1.split.setupMedianMs, " ms")} | n=${metrics.s1.split.sampleSize}; p95 ${fmt(metrics.s1.split.setupP95Ms, " ms")} |`,
  `| S1 | of which agent (prompt sent → first useful action), median | ${fmt(metrics.s1.split.agentMedianMs, " ms")} | n=${metrics.s1.split.sampleSize}; p95 ${fmt(metrics.s1.split.agentP95Ms, " ms")} |`,
  "",
  "- **Platform failure rate**: runs that failed because of the platform. Rejected logins and account or setup refusals are left out of both sides; this is the number the R2 budget checks.",
  "- **Login refusals**: runs that failed because the provider refused the login. That is an account problem for John, not a platform bug.",
  "- **Account and setup refusals**: runs refused for an expired credential, no personal default account, a connection not permitted for the agent, low trust with no sandbox, or a task with no project workspace (GRE-745). Account or setup state for the board, not a platform bug.",
  "",
  "## Repair escalations to the board",
  "",
  `\`${metrics.repairEscalations.terminalReason}\` escalations in the last ${windowDays} days: **${metrics.repairEscalations.total}** (register row 76).`,
  "",
  "| Task | Repair runs posted a comment | No comment |",
  "|---|---:|---:|",
  `| Agent-only | ${metrics.repairEscalations.agentOnlyCommented.length} | ${metrics.repairEscalations.agentOnlyNoComment.length} |`,
  `| Has a human | ${metrics.repairEscalations.otherCommented.length} | ${metrics.repairEscalations.otherNoComment.length} |`,
  "",
  ...[["Agent-only, commented", "agentOnlyCommented"], ["Agent-only, no comment", "agentOnlyNoComment"], ["Has a human, commented", "otherCommented"], ["Has a human, no comment", "otherNoComment"]]
    .map(([label, key]) => `- ${label}: ${metrics.repairEscalations[key].length ? metrics.repairEscalations[key].map((entry) => entry.identifier).join(", ") : "none"}`),
  "",
  `## Throttled rewakes (${windowDays} days)`,
  "",
  `\`${metrics.throttledRewakes.reason}\` skipped wakes: **${metrics.throttledRewakes.total}** on ${metrics.throttledRewakes.issues} issue/agent pairs; highest no-progress streak ${metrics.throttledRewakes.maxStreak} (register row 126).`,
  "",
  ...(metrics.throttledRewakes.total
    ? [
      "| Agent | Skipped wakes | Issues |",
      "|---|---:|---:|",
      ...metrics.throttledRewakes.byAgent.map((agent) => `| ${agent.name ?? agent.agentId} | ${agent.count} | ${agent.issues} |`),
      "",
      "| Issue | Agent | Skipped wakes | Highest streak | Last skipped | Wake reasons |",
      "|---|---|---:|---:|---|---|",
      ...metrics.throttledRewakes.topIssues.map((entry) => `| ${entry.identifier} (\`${entry.issueId}\`) | ${metrics.throttledRewakes.byAgent.find((agent) => agent.agentId === entry.agentId)?.name ?? entry.agentId} | ${entry.count} | ${entry.maxStreak} | ${entry.lastAt} | ${entry.requestedReasons.join(", ") || "none"} |`),
    ]
    : ["None."]),
  "",
  "## Stranded trees",
  "",
  ...(metrics.r1.stranded.length
    ? metrics.r1.stranded.map((tree) => `- ${tree.rootIdentifier ?? tree.rootIssueId}: uncovered ${tree.uncoveredIssues.map((issue) => `${issue.identifier} (${issue.status})`).join(", ")} of ${tree.openIssues.length} open; last activity ${tree.lastActivityAt}`)
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
