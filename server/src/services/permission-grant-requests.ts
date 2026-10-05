import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, approvals, heartbeatRuns, issueApprovals, issues, type Db } from "@greatstone/db";
import { PERMISSION_KEYS, type PermissionKey } from "@greatstone/shared";
import { accessService } from "./access.js";
import { logActivity } from "./activity-log.js";
import { issueService } from "./issues.js";

/**
 * GRE-601: when an agent is refused with `Missing permission: <key>`, the board
 * gets one Grant / Deny item in the attention list. The item is a
 * `permission_grant` approval, so it reuses the board-only approve / reject
 * routes, the company check on them, and the requester wake on approve.
 */
export const PERMISSION_GRANT_APPROVAL_TYPE = "permission_grant";

const OPEN_APPROVAL_STATUSES = ["pending", "revision_requested"];
const MISSING_PERMISSION_PATTERN = /^Missing permission: ([a-z_-]+:[a-z_-]+)\.?$/;

export type PermissionGrantPayload = {
  agentId: string;
  agentName: string | null;
  permissionKey: PermissionKey;
  issueId: string | null;
  issueIdentifier: string | null;
  title: string;
};

/** The permission key named by a single-key refusal message, or null. */
export function parseMissingPermissionKey(message: string): PermissionKey | null {
  const match = MISSING_PERMISSION_PATTERN.exec(message.trim());
  const key = match?.[1];
  return key && (PERMISSION_KEYS as readonly string[]).includes(key) ? (key as PermissionKey) : null;
}

export function readPermissionGrantPayload(payload: unknown): PermissionGrantPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const agentId = typeof record.agentId === "string" ? record.agentId : null;
  const permissionKey = typeof record.permissionKey === "string" ? record.permissionKey : null;
  if (!agentId || !permissionKey || !(PERMISSION_KEYS as readonly string[]).includes(permissionKey)) return null;
  return {
    agentId,
    agentName: typeof record.agentName === "string" ? record.agentName : null,
    permissionKey: permissionKey as PermissionKey,
    issueId: typeof record.issueId === "string" ? record.issueId : null,
    issueIdentifier: typeof record.issueIdentifier === "string" ? record.issueIdentifier : null,
    title: typeof record.title === "string" ? record.title : "",
  };
}

async function runIssueId(db: Db, runId: string | null | undefined, companyId: string, agentId: string) {
  if (!runId) return null;
  const run = await db
    .select({ companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId, contextSnapshot: heartbeatRuns.contextSnapshot })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .then((rows) => rows[0] ?? null);
  if (!run || run.companyId !== companyId || run.agentId !== agentId) return null;
  const context = (run.contextSnapshot ?? {}) as Record<string, unknown>;
  const issueId = typeof context.issueId === "string" ? context.issueId : typeof context.taskId === "string" ? context.taskId : "";
  return issueId.trim() || null;
}

export function permissionGrantRequestService(db: Db) {
  /**
   * Opens one Grant / Deny item for this agent and key, unless one is already
   * open. Returns the open approval and whether this call created it.
   */
  async function recordRefusal(input: {
    companyId: string;
    agentId: string;
    permissionKey: PermissionKey;
    runId?: string | null;
  }) {
    const agent = await db
      .select({ id: agents.id, name: agents.name, companyId: agents.companyId })
      .from(agents)
      .where(eq(agents.id, input.agentId))
      .then((rows) => rows[0] ?? null);
    if (!agent || agent.companyId !== input.companyId) return null;

    const issueId = await runIssueId(db, input.runId, input.companyId, input.agentId);
    const issue = issueId
      ? await db
        .select({ id: issues.id, identifier: issues.identifier })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, input.companyId)))
        .then((rows) => rows[0] ?? null)
      : null;

    const result = await db.transaction(async (tx) => {
      // Two refusals in the same moment must not open two items.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`permission-grant:${input.companyId}:${input.agentId}:${input.permissionKey}`}, 0))`,
      );
      const open = await tx
        .select()
        .from(approvals)
        .where(and(
          eq(approvals.companyId, input.companyId),
          eq(approvals.type, PERMISSION_GRANT_APPROVAL_TYPE),
          inArray(approvals.status, OPEN_APPROVAL_STATUSES),
          sql`${approvals.payload}->>'agentId' = ${input.agentId}`,
          sql`${approvals.payload}->>'permissionKey' = ${input.permissionKey}`,
        ))
        .then((rows) => rows[0] ?? null);
      if (open) return { approval: open, created: false };

      const payload: PermissionGrantPayload = {
        agentId: agent.id,
        agentName: agent.name,
        permissionKey: input.permissionKey,
        issueId: issue?.id ?? null,
        issueIdentifier: issue?.identifier ?? null,
        title: issue?.identifier
          ? `${agent.name} needs ${input.permissionKey} for ${issue.identifier}`
          : `${agent.name} needs ${input.permissionKey}`,
      };
      const approval = await tx
        .insert(approvals)
        .values({
          companyId: input.companyId,
          type: PERMISSION_GRANT_APPROVAL_TYPE,
          requestedByAgentId: agent.id,
          status: "pending",
          payload,
        })
        .returning()
        .then((rows) => rows[0]!);
      if (issue) {
        await tx.insert(issueApprovals).values({
          companyId: input.companyId,
          issueId: issue.id,
          approvalId: approval.id,
          linkedByAgentId: agent.id,
        });
      }
      return { approval, created: true };
    });

    if (result.created) {
      await logActivity(db, {
        companyId: input.companyId,
        actorType: "system",
        actorId: "permission-grant-request",
        agentId: agent.id,
        issueId: issue?.id ?? null,
        action: "approval.created",
        entityType: "approval",
        entityId: result.approval.id,
        details: { type: PERMISSION_GRANT_APPROVAL_TYPE, permissionKey: input.permissionKey },
      });
    }
    return result;
  }

  /** Writes the grant through the same service the board agent-permission route uses. */
  async function applyGrant(approval: { companyId: string; payload: unknown }, decidedByUserId: string | null) {
    const payload = readPermissionGrantPayload(approval.payload);
    if (!payload) return;
    await accessService(db).setPrincipalPermission(
      approval.companyId,
      "agent",
      payload.agentId,
      payload.permissionKey,
      true,
      decidedByUserId,
    );
  }

  /** Tells the blocked task that the board refused the grant. */
  async function commentOnDenial(approval: { payload: unknown }, decidedByUserId: string, decisionNote?: string | null) {
    const payload = readPermissionGrantPayload(approval.payload);
    if (!payload?.issueId) return null;
    const who = payload.agentName ?? "The agent";
    const note = decisionNote?.trim() ? `\n\nNote: ${decisionNote.trim()}` : "";
    const body = `The board refused the grant \`${payload.permissionKey}\`. ${who} must finish this task without it, or hand it to an agent that has it.${note}`;
    return issueService(db).addComment(payload.issueId, body, { userId: decidedByUserId });
  }

  return { recordRefusal, applyGrant, commentOnDenial };
}
