import { computeStrandedTrees } from "./compute.mjs";

export const R1_TABLE_COLUMNS = Object.freeze({
  issues: ["id", "company_id", "identifier", "parent_id", "status", "assignee_agent_id", "assignee_user_id", "conversation_user_id", "conversation_state", "monitor_next_check_at", "monitor_wake_requested_at", "hidden_at", "updated_at", "tabled_by_user_id"],
  activity_log: ["company_id", "entity_type", "entity_id", "actor_type", "action", "details", "created_at"],
  heartbeat_runs: ["company_id", "id", "status", "context_snapshot", "native_issue_id", "created_at", "started_at", "last_output_at", "finished_at"],
  agent_wakeup_requests: ["company_id", "status", "payload"],
  issue_thread_interactions: ["company_id", "issue_id", "status"],
  issue_approvals: ["company_id", "issue_id", "approval_id"],
  approvals: ["id", "company_id", "status"],
  issue_recovery_actions: ["company_id", "source_issue_id", "resolved_at", "status", "cause", "evidence"],
  issue_tree_holds: ["company_id", "root_issue_id", "status"],
  issue_relations: ["company_id", "issue_id", "related_issue_id", "type"],
  agents: ["company_id", "id", "status", "runtime_config"],
});

const rowQueries = {
  issues: `select id, company_id as "companyId", identifier, parent_id as "parentId", status,
    assignee_agent_id as "assigneeAgentId", assignee_user_id as "assigneeUserId",
    conversation_user_id as "conversationUserId", conversation_state as "conversationState",
    monitor_next_check_at as "monitorNextCheckAt", monitor_wake_requested_at as "monitorWakeRequestedAt",
    hidden_at as "hiddenAt", updated_at as "updatedAt", tabled_by_user_id as "tabledByUserId"
    from public.issues where company_id = $1`,
  backlogParkers: `select distinct on (a.entity_id) a.company_id as "companyId", a.entity_id as "issueId", a.actor_type as "actorType"
    from public.activity_log a join public.issues i on i.id::text = a.entity_id
    where a.company_id = $1 and i.company_id = $1 and a.entity_type = 'issue' and i.status = 'backlog'
      and (a.action = 'issue.tabled' or a.details->>'status' = 'backlog')
    order by a.entity_id, a.created_at desc`,
  runs: `select company_id as "companyId", id, status, context_snapshot->>'issueId' as "issueId",
    context_snapshot->>'taskId' as "taskId", native_issue_id as "nativeIssueId",
    created_at as "createdAt", started_at as "startedAt", last_output_at as "lastOutputAt",
    finished_at as "finishedAt" from public.heartbeat_runs r where r.company_id = $1
    and exists (select 1 from public.issues i where i.company_id = $1 and i.id::text in
      (r.context_snapshot->>'issueId', r.context_snapshot->>'taskId', r.native_issue_id::text))`,
  wakeRequests: `select company_id as "companyId", status, payload->>'issueId' as "issueId", payload->>'taskId' as "taskId",
    payload->'_paperclipWakeContext'->>'issueId' as "contextIssueId",
    payload->'_paperclipWakeContext'->>'taskId' as "contextTaskId"
    from public.agent_wakeup_requests where company_id = $1 and status in ('queued', 'deferred_issue_execution', 'claimed')`,
  interactions: `select company_id as "companyId", issue_id as "issueId", status from public.issue_thread_interactions
    where company_id = $1 and status = 'pending'`,
  approvals: `select ia.company_id as "companyId", ia.issue_id as "issueId", a.status from public.issue_approvals ia
    join public.approvals a on a.id = ia.approval_id
    where ia.company_id = $1 and a.company_id = $1 and a.status in ('pending', 'revision_requested')`,
  recoveryActions: `select company_id as "companyId", source_issue_id as "sourceIssueId", resolved_at as "resolvedAt", status, cause,
    evidence->'automaticRecovery'->>'replay' as replay from public.issue_recovery_actions
    where company_id = $1 and (resolved_at is null or evidence->'automaticRecovery'->>'replay' = 'blocked')`,
  treeHolds: `select company_id as "companyId", root_issue_id as "rootIssueId", status from public.issue_tree_holds
    where company_id = $1 and status = 'active'`,
  relations: `select company_id as "companyId", issue_id as "blockerIssueId", related_issue_id as "blockedIssueId"
    from public.issue_relations where company_id = $1 and type = 'blocks'`,
  agents: `select company_id as "companyId", id, status, coalesce((runtime_config->'heartbeat'->>'enabled')::boolean, false) as "timerHeartbeat"
    from public.agents where company_id = $1`,
};

const references = {
  issues: ["parentId"], runs: ["issueId", "taskId", "nativeIssueId"],
  wakeRequests: ["issueId", "taskId", "contextIssueId", "contextTaskId"],
  interactions: ["issueId"], approvals: ["issueId"], recoveryActions: ["sourceIssueId"],
  treeHolds: ["rootIssueId"], relations: ["blockerIssueId", "blockedIssueId"],
  backlogParkers: ["issueId"],
};

const requiredColumns = {
  issues: ["id", "companyId", "identifier", "parentId", "status", "assigneeAgentId", "assigneeUserId", "conversationUserId", "conversationState", "monitorNextCheckAt", "monitorWakeRequestedAt", "hiddenAt", "updatedAt", "tabledByUserId"],
  backlogParkers: ["companyId", "issueId", "actorType"],
  runs: ["companyId", "id", "status", "issueId", "taskId", "nativeIssueId", "createdAt", "startedAt", "lastOutputAt", "finishedAt"],
  wakeRequests: ["companyId", "status", "issueId", "taskId", "contextIssueId", "contextTaskId"],
  interactions: ["companyId", "issueId", "status"],
  approvals: ["companyId", "issueId", "status"],
  recoveryActions: ["companyId", "sourceIssueId", "resolvedAt", "status", "cause", "replay"],
  treeHolds: ["companyId", "rootIssueId", "status"],
  relations: ["companyId", "blockerIssueId", "blockedIssueId"],
  agents: ["companyId", "id", "status", "timerHeartbeat"],
};

export function validateR1Snapshot(snapshot, companyId) {
  if (!companyId || typeof companyId !== "string") throw new Error("R1 requires a company ID");
  if (!snapshot || !Number.isFinite(Date.parse(snapshot.snapshotAt ?? ""))) throw new Error("R1 requires a database snapshot timestamp");
  for (const key of Object.keys(rowQueries)) {
    if (!Array.isArray(snapshot[key])) throw new Error(`R1 missing input: ${key}`);
    for (const row of snapshot[key]) {
      if (!row || typeof row !== "object") throw new Error(`R1 invalid row: ${key}`);
      for (const column of requiredColumns[key]) {
        if (!Object.hasOwn(row, column)) throw new Error(`R1 missing column: ${key}.${column}`);
      }
      if (row.companyId !== companyId) throw new Error(`R1 ${key} row belongs to another company`);
    }
  }
  const ids = new Set();
  for (const issue of snapshot.issues) {
    if (issue.companyId !== companyId) throw new Error("R1 issue belongs to another company");
    if (!issue.id || ids.has(issue.id)) throw new Error("R1 requires unique issue IDs");
    ids.add(issue.id);
  }
  for (const [key, columns] of Object.entries(references)) {
    for (const row of snapshot[key]) for (const column of columns) {
      if (row[column] && !ids.has(row[column])) throw new Error(`R1 ${key}.${column} references an issue outside the company snapshot`);
    }
  }
  for (const issue of snapshot.issues) {
    if (issue.assigneeAgentId && !snapshot.agents.some((agent) => agent.id === issue.assigneeAgentId)) {
      throw new Error("R1 missing assignee agent");
    }
  }
  return snapshot;
}

export async function captureR1Snapshot(tx, companyId, { sourceCapturedAt, verifySource } = {}) {
  if (!companyId || typeof companyId !== "string") throw new Error("R1 requires a company ID");
  const time = await tx.unsafe("select transaction_timestamp() as \"snapshotAt\"");
  const readAt = time[0]?.snapshotAt;
  if (!Number.isFinite(Date.parse(readAt ?? ""))) throw new Error("R1 requires a database transaction timestamp");
  if (sourceCapturedAt && (!Number.isFinite(Date.parse(sourceCapturedAt)) || Date.parse(sourceCapturedAt) > Date.parse(readAt))) {
    throw new Error("R1 requires an original source capture timestamp no later than the database read");
  }
  if (verifySource) await verifySource(tx);
  const snapshot = { snapshotAt: sourceCapturedAt ?? readAt, readAt };
  for (const [key, query] of Object.entries(rowQueries)) snapshot[key] = await tx.unsafe(query, [companyId]);
  return validateR1Snapshot(snapshot, companyId);
}

export function calculateR1(snapshot, companyId, { windowDays = 7 } = {}) {
  validateR1Snapshot(snapshot, companyId);
  if (!Number.isInteger(windowDays) || windowDays < 1) throw new Error("R1 window days must be a positive integer");
  return computeStrandedTrees(snapshot, { now: snapshot.snapshotAt, windowDays });
}

export function summariseR1(snapshot, companyId, sourceRef) {
  if (!sourceRef || typeof sourceRef !== "string") throw new Error("R1 requires an approved source reference");
  const r1 = calculateR1(snapshot, companyId);
  return {
    schema: "gsam.r1-result/v1", sourceRef, companyId,
    sourceCapturedAt: new Date(snapshot.snapshotAt).toISOString(),
    readAt: new Date(snapshot.readAt ?? snapshot.snapshotAt).toISOString(),
    windowStart: new Date(Date.parse(snapshot.snapshotAt) - 7 * 86_400_000).toISOString(),
    windowDays: 7,
    weekly: r1.weekly, total: r1.total, treesWithOpenWork: r1.treesWithOpenWork,
    countedRoots: r1.stranded.filter((tree) => tree.stoppedInWindow)
      .map((tree) => ({ rootIssueId: tree.rootIssueId, rootIdentifier: tree.rootIdentifier })),
  };
}
