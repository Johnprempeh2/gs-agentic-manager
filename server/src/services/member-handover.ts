import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  activityLog,
  agentConfigRevisions,
  agents,
  authAccounts,
  authSessions,
  authUsers,
  boardApiKeys,
  companies,
  companyMemberships,
  connectionGrantMembers,
  connectionGrants,
  heartbeatRuns,
  instanceSettings,
  instanceUserRoles,
  issueThreadInteractions,
  issues,
  principalPermissionGrants,
  routineRevisions,
  routineRuns,
  routines,
  toolConnections,
} from "@greatstone/db";
import {
  AI_CONNECTION_CAPABILITIES,
  AI_ACCESS_ROUTABLE_ADAPTER_TYPES,
  aiConnectionBindingSchema,
  aiConnectionMetadataSchema,
  type AiConnectionBinding,
  type DeploymentMode,
  type MemberHandoverAction,
  type MemberHandoverChoice,
  type MemberHandoverControls,
  type MemberHandoverItem,
  type MemberHandoverOverride,
  type MemberHandoverPlan,
  type MemberHandoverReconnect,
  type MemberHandoverRestoreResult,
  type MemberHandoverSharedAiAccount,
  type RoutineRevisionSnapshotV1,
} from "@greatstone/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { accessService } from "./access.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { applyAiAccessRoute, readAiAccessRoute, resolveAiAccessRouteBinding } from "./ai-access-route.js";
import { aiConnectionService } from "./ai-connections.js";
import { LEGACY_BOARD_USER_ID, primaryOwnerUserId } from "./board-identity.js";
import { issueService } from "./issues.js";
import {
  findOpenWorkForUser,
  rebindExecutionPolicy,
  rebindExecutionState,
  type OpenWorkForUser,
} from "./legacy-board-reassignment.js";
import { ensureHumanRoleDefaultGrants } from "./principal-access-compatibility.js";

/**
 * Hand over and remove a person who is leaving the company.
 *
 * The plan lists everything in this company that depends on the person, with
 * a recommended action for each item and the target after the caller's
 * overrides. A dry run returns the plan and writes nothing. Executing applies
 * every move in one transaction: open work, pending asks, routines (and their
 * latest revision), the company default responsible person and queued runs go
 * to the successor (or the chosen person or agent); agents that would run on
 * the person's own AI account are pointed at the successor's default or a
 * shared account, never left with none; personal connections and GitHub
 * identity grants are revoked (personal credentials cannot be transferred, so
 * the successor is told what to reconnect); memory and other permission
 * grants are removed; the membership is archived (suspended for owners and
 * admins); board API keys are revoked and sign-in sessions ended. A task
 * "Handover from <name>" is created for the successor.
 *
 * Restore reverses access only: the membership, the permission grants the
 * handover removed (memory rights excepted, which only the owner route sets)
 * and an instance admin role the handover removed. Moved work stays moved.
 */

export const MEMBER_HANDED_OVER_ACTION = "company_member.handed_over";
export const MEMBER_RESTORED_ACTION = "company_member.restored";

const QUEUED_RUN_STATUSES = ["queued", "scheduled_retry"];
const OPEN_ROUTINE_RUN_STATUSES = ["received", "issue_created"];

type DbReader = Pick<Db, "select">;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type HandoverActor = {
  type: string;
  userId?: string | null;
  source?: string | null;
  isInstanceAdmin?: boolean;
};

export type HandoverCaller = { userId: string; role: "owner" | "admin" };

type MembershipRow = typeof companyMemberships.$inferSelect;

const ROLE_LABEL: Record<string, string> = {
  assignee: "assignee",
  responsible: "responsible",
  current_reviewer: "current reviewer",
  return_assignee: "return assignee",
  review_participant: "review step",
};

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

function providerName(provider: string) {
  return (AI_CONNECTION_CAPABILITIES as Record<string, { name: string } | undefined>)[provider]?.name ?? provider;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Who may run it
// ---------------------------------------------------------------------------

/** The caller's user id and effective role, or a 403. Owners and admins only. */
export async function resolveHandoverCaller(
  db: DbReader,
  input: { companyId: string; actor: HandoverActor },
): Promise<HandoverCaller> {
  const { actor, companyId } = input;
  if (actor.type !== "board") throw forbidden("Only a signed-in company owner or admin can hand over a person's work.");
  if (actor.source === "local_implicit") return { userId: actor.userId ?? LEGACY_BOARD_USER_ID, role: "owner" };
  if (!actor.userId) throw forbidden("Only a signed-in company owner or admin can hand over a person's work.");
  if (actor.isInstanceAdmin) return { userId: actor.userId, role: "owner" };
  const [membership] = await db
    .select({ status: companyMemberships.status, role: companyMemberships.membershipRole })
    .from(companyMemberships)
    .where(and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, actor.userId),
    ))
    .limit(1);
  if (membership?.status === "active" && (membership.role === "owner" || membership.role === "admin")) {
    return { userId: actor.userId, role: membership.role };
  }
  throw forbidden("Only a company owner or admin can hand over a person's work.");
}

async function countOtherActiveOwners(db: DbReader, companyId: string, excludeUserId: string) {
  const rows = await db
    .select({ principalId: companyMemberships.principalId })
    .from(companyMemberships)
    .where(and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.status, "active"),
      eq(companyMemberships.membershipRole, "owner"),
      ne(companyMemberships.principalId, excludeUserId),
      ne(companyMemberships.principalId, LEGACY_BOARD_USER_ID),
    ));
  return rows.length;
}

/** Why this caller may not hand over this member, or null when they may. */
export async function handoverRefusalReason(
  db: DbReader,
  input: { companyId: string; deploymentMode: DeploymentMode; caller: HandoverCaller; member: MembershipRow },
): Promise<string | null> {
  const { member, caller } = input;
  if (member.principalType !== "user") return "Only people can be handed over.";
  if (member.principalId === LEGACY_BOARD_USER_ID && input.deploymentMode !== "authenticated") {
    return "In local_trusted mode the legacy local-board account is the board itself, so it cannot be handed over.";
  }
  if (member.principalId === caller.userId) return "You cannot hand over yourself. Ask another owner or admin.";
  if (member.status === "archived") return "This person has already been removed.";
  const role = member.membershipRole ?? "operator";
  if ((role === "owner" || role === "admin") && caller.role !== "owner") {
    return "Only an owner can hand over an owner or admin.";
  }
  if (role === "owner" && member.status === "active"
    && (await countOtherActiveOwners(db, input.companyId, member.principalId)) === 0) {
    return "This is the last active owner. Make someone else an owner first.";
  }
  return null;
}

/** Why this caller may not restore this member, or null when they may. */
export function restoreRefusalReason(input: {
  deploymentMode: DeploymentMode;
  caller: HandoverCaller;
  member: MembershipRow;
}): string | null {
  const { member, caller } = input;
  if (member.principalType !== "user") return "Only people can be restored.";
  if (member.status !== "archived" && member.status !== "suspended") return "This person is not removed.";
  if (member.principalId === LEGACY_BOARD_USER_ID && input.deploymentMode !== "authenticated") {
    return "In local_trusted mode the legacy local-board account is the board itself.";
  }
  if (member.principalId === caller.userId) return "You cannot restore yourself.";
  const role = member.membershipRole ?? "operator";
  if ((role === "owner" || role === "admin") && caller.role !== "owner") {
    return "Only an owner can restore an owner or admin.";
  }
  return null;
}

/** The per-row controls for the Members page. Never throws. */
export async function describeMemberHandoverControls(
  db: DbReader,
  input: { companyId: string; deploymentMode: DeploymentMode; actor: HandoverActor; members: MembershipRow[] },
): Promise<Map<string, MemberHandoverControls>> {
  const result = new Map<string, MemberHandoverControls>();
  let caller: HandoverCaller | null = null;
  try {
    caller = await resolveHandoverCaller(db, input);
  } catch {
    caller = null;
  }
  for (const member of input.members) {
    if (!caller) {
      result.set(member.id, {
        canHandOver: false,
        handOverReason: "Only a company owner or admin can hand over a person's work.",
        canRestore: false,
        restoreReason: "Only a company owner or admin can restore a person.",
      });
      continue;
    }
    const handOverReason = member.status === "archived" || member.status === "suspended"
      ? "This person is already removed."
      : await handoverRefusalReason(db, { ...input, caller, member });
    const restoreReason = restoreRefusalReason({ ...input, caller, member });
    result.set(member.id, {
      canHandOver: !handOverReason,
      handOverReason,
      canRestore: !restoreReason,
      restoreReason,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

type AgentRow = {
  id: string;
  name: string;
  status: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
};

type RoutineRow = {
  id: string;
  title: string;
  status: string;
  assigneeAgentId: string | null;
  responsibleUserId: string | null;
  latestRevisionId: string | null;
  revisionResponsibleUserId: string | null;
  revisionSnapshot: unknown;
};

type InteractionRow = {
  id: string;
  kind: string;
  title: string | null;
  issueId: string;
  issueIdentifier: string | null;
};

type GrantRow = {
  id: string;
  connectionId: string;
  connectionName: string;
  purpose: string;
  config: Record<string, unknown>;
  transportConfig: Record<string, unknown>;
  status: string;
};

type AgentPlanData = {
  agent: AgentRow;
  binding: AiConnectionBinding | null;
  routed: boolean;
};

/** Everything the execute step needs besides the visible plan. */
type PlanInternals = {
  member: MembershipRow;
  userId: string;
  work: OpenWorkForUser;
  interactions: InteractionRow[];
  routines: RoutineRow[];
  agents: Map<string, AgentPlanData>;
  defaultResponsible: boolean;
  queuedRunCount: number;
  grants: GrantRow[];
  permissionGrants: Array<{ permissionKey: string; scope: Record<string, unknown> | null }>;
  membershipTo: "archived" | "suspended";
  instanceAdmin: "not_held" | "kept" | "remove";
  revokeKeys: boolean;
  companyPrefix: string;
  names: Map<string, string>;
};

type BuildInput = {
  companyId: string;
  deploymentMode: DeploymentMode;
  caller: HandoverCaller;
  member: MembershipRow;
  successorUserId: string;
  overrides: MemberHandoverOverride[];
  removeInstanceAdmin: boolean;
  dryRun: boolean;
};

async function loadUserNames(db: DbReader, ids: string[]) {
  const unique = [...new Set(ids.filter(Boolean))];
  const names = new Map<string, { name: string; email: string | null }>();
  if (unique.length === 0) return names;
  const rows = await db
    .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email })
    .from(authUsers)
    .where(inArray(authUsers.id, unique));
  for (const row of rows) names.set(row.id, { name: row.name?.trim() || row.email || row.id, email: row.email ?? null });
  for (const id of unique) if (!names.has(id)) names.set(id, { name: id, email: null });
  return names;
}

async function activeHumanMembers(db: DbReader, companyId: string) {
  const rows = await db
    .select({ principalId: companyMemberships.principalId })
    .from(companyMemberships)
    .where(and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.status, "active"),
    ));
  return new Set(rows.map((row) => row.principalId));
}

async function readAccessRoute(db: DbReader) {
  // Read the stored row directly: the settings service creates the row on
  // first read, and a dry run must not write.
  const [row] = await db.select({ general: instanceSettings.general }).from(instanceSettings).limit(1);
  return readAiAccessRoute((row?.general ?? null) as { aiAccessRoute?: unknown } | null);
}

function isGithubConnection(config: Record<string, unknown>, transportConfig: Record<string, unknown>) {
  return config.sourceTemplateKey === "github" || transportConfig.sourceTemplateKey === "github";
}

function snapshotResponsibleUserId(snapshot: unknown): string | null {
  const value = (snapshot as RoutineRevisionSnapshotV1 | null | undefined)?.routine?.responsibleUserId;
  return typeof value === "string" ? value : null;
}

/**
 * Build the handover plan. Read-only: the dry run returns it as is, and the
 * execute step builds it again inside its transaction before applying it.
 */
async function buildPlan(db: Db, input: BuildInput): Promise<{ plan: MemberHandoverPlan; internals: PlanInternals }> {
  const { companyId, member, successorUserId, caller } = input;
  const userId = member.principalId;
  const blockers: string[] = [];
  const warnings: string[] = [];
  const items: MemberHandoverItem[] = [];
  const reconnect: MemberHandoverReconnect[] = [];

  const refusal = await handoverRefusalReason(db, { companyId, deploymentMode: input.deploymentMode, caller, member });
  if (refusal) throw forbidden(refusal);
  if (member.status === "suspended") throw conflict("This person is already suspended. Restore them before handing over.");

  const active = await activeHumanMembers(db, companyId);
  if (successorUserId === userId) throw unprocessable("The successor must be someone other than the person leaving.");
  if (!active.has(successorUserId)) throw unprocessable("The successor must be an active person in this company.");
  if (successorUserId === LEGACY_BOARD_USER_ID && input.deploymentMode === "authenticated") {
    throw unprocessable("The legacy local-board account cannot sign in, so it cannot take over work.");
  }

  const [company] = await db
    .select({ prefix: companies.issuePrefix, defaultResponsibleUserId: companies.defaultResponsibleUserId })
    .from(companies)
    .where(eq(companies.id, companyId));
  if (!company) throw notFound("Company not found");

  // --- Read everything that names the person -------------------------------
  const work = await findOpenWorkForUser(db, companyId, userId);
  const interactions: InteractionRow[] = await db
    .select({
      id: issueThreadInteractions.id,
      kind: issueThreadInteractions.kind,
      title: issueThreadInteractions.title,
      issueId: issueThreadInteractions.issueId,
      issueIdentifier: issues.identifier,
    })
    .from(issueThreadInteractions)
    .innerJoin(issues, eq(issues.id, issueThreadInteractions.issueId))
    .where(and(
      eq(issueThreadInteractions.companyId, companyId),
      eq(issueThreadInteractions.status, "pending"),
      eq(issueThreadInteractions.addresseeUserId, userId),
    ))
    .orderBy(asc(issueThreadInteractions.createdAt));
  const routineRows: RoutineRow[] = await db
    .select({
      id: routines.id,
      title: routines.title,
      status: routines.status,
      assigneeAgentId: routines.assigneeAgentId,
      responsibleUserId: routines.responsibleUserId,
      latestRevisionId: routines.latestRevisionId,
      revisionResponsibleUserId: routineRevisions.responsibleUserId,
      revisionSnapshot: routineRevisions.snapshot,
    })
    .from(routines)
    .leftJoin(routineRevisions, eq(routineRevisions.id, routines.latestRevisionId))
    .where(and(
      eq(routines.companyId, companyId),
      or(
        eq(routines.responsibleUserId, userId),
        eq(routineRevisions.responsibleUserId, userId),
        sql`${routineRevisions.snapshot} -> 'routine' ->> 'responsibleUserId' = ${userId}`,
      ),
    ))
    .orderBy(asc(routines.title));
  const queuedRuns = await db
    .select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, companyId),
      inArray(heartbeatRuns.status, QUEUED_RUN_STATUSES),
      eq(heartbeatRuns.responsibleUserId, userId),
    ));
  const [{ running } = { running: 0 }] = await db
    .select({ running: sql<number>`count(*)::int` })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, companyId),
      eq(heartbeatRuns.status, "running"),
      eq(heartbeatRuns.responsibleUserId, userId),
    ));
  const agentRows: AgentRow[] = await db
    .select({
      id: agents.id,
      name: agents.name,
      status: agents.status,
      adapterType: agents.adapterType,
      adapterConfig: agents.adapterConfig,
      runtimeConfig: agents.runtimeConfig,
    })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")))
    .orderBy(asc(agents.name));
  const grantRows: GrantRow[] = await db
    .select({
      id: connectionGrants.id,
      connectionId: toolConnections.id,
      connectionName: toolConnections.name,
      purpose: toolConnections.connectionPurpose,
      config: toolConnections.config,
      transportConfig: toolConnections.transportConfig,
      status: connectionGrants.status,
    })
    .from(connectionGrants)
    .innerJoin(toolConnections, and(
      eq(toolConnections.companyId, connectionGrants.companyId),
      eq(toolConnections.id, connectionGrants.connectionId),
    ))
    .where(and(
      eq(connectionGrants.companyId, companyId),
      eq(connectionGrants.kind, "user"),
      eq(connectionGrants.subjectUserId, userId),
      ne(connectionGrants.status, "revoked"),
    ))
    .orderBy(asc(toolConnections.name));
  const audienceRows = await db
    .select({ grantId: connectionGrantMembers.grantId })
    .from(connectionGrantMembers)
    .where(and(
      eq(connectionGrantMembers.companyId, companyId),
      eq(connectionGrantMembers.subjectType, "user"),
      eq(connectionGrantMembers.subjectId, userId),
    ));
  const permissionRows = await db
    .select({ permissionKey: principalPermissionGrants.permissionKey, scope: principalPermissionGrants.scope })
    .from(principalPermissionGrants)
    .where(and(
      eq(principalPermissionGrants.companyId, companyId),
      eq(principalPermissionGrants.principalType, "user"),
      eq(principalPermissionGrants.principalId, userId),
    ));
  const adminRoles = await db
    .select({ id: instanceUserRoles.id })
    .from(instanceUserRoles)
    .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")));
  const otherAdmins = await db
    .select({ id: instanceUserRoles.id })
    .from(instanceUserRoles)
    .where(and(ne(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")));
  const signInAccounts = await db.select({ id: authAccounts.id }).from(authAccounts).where(eq(authAccounts.userId, userId));
  const liveKeys = await db
    .select({ id: boardApiKeys.id })
    .from(boardApiKeys)
    .where(and(eq(boardApiKeys.userId, userId), isNull(boardApiKeys.revokedAt)));
  const sessions = await db.select({ id: authSessions.id }).from(authSessions).where(eq(authSessions.userId, userId));
  const otherCompanies = await db
    .select({ companyId: companyMemberships.companyId })
    .from(companyMemberships)
    .where(and(
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, userId),
      eq(companyMemberships.status, "active"),
      ne(companyMemberships.companyId, companyId),
    ));

  const agentById = new Map(agentRows.map((agent) => [agent.id, agent]));
  const names = new Map<string, string>();
  const people = await loadUserNames(db, [userId, successorUserId, ...input.overrides.flatMap((o) => (o.toUserId ? [o.toUserId] : []))]);
  for (const [id, person] of people) names.set(id, person.name);
  const nameOf = (id: string) => names.get(id) ?? id;
  const leaver = people.get(userId)!;
  const successorName = nameOf(successorUserId);

  // --- Overrides ------------------------------------------------------------
  const overrides = new Map<string, MemberHandoverOverride>();
  for (const override of input.overrides) overrides.set(override.itemRef, override);
  const usedRefs = new Set<string>();

  /** Resolve an item's planned action from its recommendation and any override. */
  function plannedFor(
    ref: string,
    recommended: MemberHandoverAction,
    choices: MemberHandoverChoice[],
  ): { planned: MemberHandoverAction; blocker: string | null } {
    const override = overrides.get(ref);
    if (!override) return { planned: recommended, blocker: null };
    usedRefs.add(ref);
    if (override.toUserId !== undefined) {
      if (!choices.includes("user")) return { planned: recommended, blocker: "This item cannot go to another person." };
      if (override.toUserId === userId || !active.has(override.toUserId)
        || (override.toUserId === LEGACY_BOARD_USER_ID && input.deploymentMode === "authenticated")) {
        return { planned: recommended, blocker: "Choose an active person who is not leaving." };
      }
      return { planned: { type: "move_to_user", userId: override.toUserId }, blocker: null };
    }
    if (override.toAgentId !== undefined) {
      if (!choices.includes("agent")) return { planned: recommended, blocker: "This item cannot go to an agent." };
      const agent = agentById.get(override.toAgentId);
      if (!agent || agent.status === "pending_approval") {
        return { planned: recommended, blocker: "Choose an active agent in this company." };
      }
      return { planned: { type: "move_to_agent", agentId: agent.id }, blocker: null };
    }
    const action = override.action!;
    if (!choices.includes(action)) return { planned: recommended, blocker: `"${action}" is not an option for this item.` };
    switch (action) {
      case "leave": return { planned: { type: "leave" }, blocker: null };
      case "unassign": return { planned: { type: "unassign" }, blocker: null };
      case "close": return { planned: { type: "close" }, blocker: null };
      case "clear": return { planned: { type: "clear" }, blocker: null };
      case "use_personal_default": return { planned: { type: "use_personal_default" }, blocker: null };
      case "use_shared_connection":
        return { planned: { type: "use_shared_connection", connectionId: "", grantId: override.sharedGrantId!, name: "" }, blocker: null };
    }
  }

  const successorMove: MemberHandoverAction = { type: "move_to_user", userId: successorUserId };
  /** Per agent, the people who will be responsible for its work after the move. */
  const agentNewResponsible = new Map<string, Set<string>>();
  const noteAgentResponsible = (agentId: string | null, planned: MemberHandoverAction) => {
    if (!agentId) return;
    const target = planned.type === "move_to_user" ? planned.userId
      : planned.type === "leave" || planned.type === "close" ? null
      : successorUserId;
    if (!target) return;
    const set = agentNewResponsible.get(agentId) ?? new Set<string>();
    set.add(target);
    agentNewResponsible.set(agentId, set);
  };

  // --- Open work ------------------------------------------------------------
  for (const issue of work.issues) {
    const ref = `issue:${issue.id}`;
    const isConversation = issue.conversationUserId === userId;
    const choices: MemberHandoverChoice[] = ["user", "close", "leave"];
    if (issue.roles.includes("assignee")) choices.splice(1, 0, "agent", "unassign");
    const recommended: MemberHandoverAction = isConversation ? { type: "close" } : successorMove;
    const { planned, blocker } = plannedFor(ref, recommended, choices);
    const label = issue.identifier ?? issue.id.slice(0, 8);
    items.push({
      ref,
      group: "work",
      kind: "issue",
      title: `${label} ${issue.title}`,
      detail: isConversation
        ? `Private chat with an agent (${issue.status}). Closed by default: it belongs to ${leaver.name}.`
        : `${issue.status.replace(/_/g, " ")}: ${issue.roles.map((role) => ROLE_LABEL[role] ?? role).join(", ")}`,
      link: `/issues/${issue.identifier ?? issue.id}`,
      roles: issue.roles,
      recommended,
      planned,
      choices,
      blocker,
      warning: planned.type === "leave" ? `Still names ${leaver.name} after they leave.` : null,
    });
    if (issue.roles.includes("responsible")) noteAgentResponsible(issue.assigneeAgentId, planned);
  }

  for (const interaction of interactions) {
    const ref = `interaction:${interaction.id}`;
    const { planned, blocker } = plannedFor(ref, successorMove, ["user", "leave"]);
    items.push({
      ref,
      group: "requests",
      kind: "interaction",
      title: interaction.title?.trim() || interaction.kind.replace(/_/g, " "),
      detail: `Pending ${interaction.kind.replace(/_/g, " ")} on ${interaction.issueIdentifier ?? interaction.issueId.slice(0, 8)}`,
      link: `/issues/${interaction.issueIdentifier ?? interaction.issueId}`,
      recommended: successorMove,
      planned,
      choices: ["user", "leave"],
      blocker,
      warning: planned.type === "leave" ? `Nobody will be able to answer this once ${leaver.name} has left.` : null,
    });
  }

  for (const routine of routineRows) {
    const ref = `routine:${routine.id}`;
    const { planned, blocker } = plannedFor(ref, successorMove, ["user", "leave"]);
    const agentName = routine.assigneeAgentId ? agentById.get(routine.assigneeAgentId)?.name : null;
    const leaveBlocked = planned.type === "leave" && routine.status === "active";
    items.push({
      ref,
      group: "routines",
      kind: "routine",
      title: routine.title,
      detail: `${routine.status}${agentName ? `, runs as ${agentName}` : ""}`,
      link: `/routines/${routine.id}`,
      recommended: successorMove,
      planned,
      choices: ["user", "leave"],
      blocker: blocker ?? (leaveBlocked
        ? `This routine is active. Its runs would stop with "The responsible user is not an active company member". Give it to someone or pause it first.`
        : null),
      warning: planned.type === "leave" && !leaveBlocked ? `If this routine is resumed it will need a new responsible person.` : null,
    });
    noteAgentResponsible(routine.assigneeAgentId, planned);
  }

  const defaultResponsible = company.defaultResponsibleUserId === userId;
  if (defaultResponsible) {
    const ref = "company_default";
    const { planned, blocker } = plannedFor(ref, successorMove, ["user", "clear"]);
    items.push({
      ref,
      group: "routines",
      kind: "company_default",
      title: "Company default responsible person",
      detail: "Used when work has no other responsible person.",
      link: "/company/settings",
      recommended: successorMove,
      planned,
      choices: ["user", "clear"],
      blocker,
      warning: planned.type === "clear" ? "Work with no responsible person will fall back to no one." : null,
    });
  }

  if (queuedRuns.length > 0) {
    items.push({
      ref: "queued_runs",
      group: "agents",
      kind: "queued_runs",
      title: "Queued agent runs",
      detail: `${plural(queuedRuns.length, "run")} waiting to start on ${leaver.name}'s behalf`,
      link: null,
      count: queuedRuns.length,
      recommended: successorMove,
      planned: successorMove,
      choices: [],
      blocker: null,
      warning: null,
    });
    for (const run of queuedRuns) noteAgentResponsible(run.agentId, successorMove);
  }
  if (running > 0) {
    warnings.push(`${plural(running, "agent run")} in progress for ${leaver.name} will finish on their current account.`);
  }

  // --- Agents and AI accounts ----------------------------------------------
  const route = await readAccessRoute(db);
  const ai = aiConnectionService(db);
  const ownGrantIds = new Set(grantRows.map((grant) => grant.id));
  const sharedAiRows = await db
    .select({
      connectionId: toolConnections.id,
      name: toolConnections.name,
      config: toolConnections.config,
      grantId: connectionGrants.id,
    })
    .from(connectionGrants)
    .innerJoin(toolConnections, and(
      eq(toolConnections.companyId, connectionGrants.companyId),
      eq(toolConnections.id, connectionGrants.connectionId),
    ))
    .where(and(
      eq(connectionGrants.companyId, companyId),
      eq(connectionGrants.kind, "organization"),
      eq(connectionGrants.status, "active"),
      eq(toolConnections.connectionPurpose, "ai"),
    ))
    .orderBy(asc(toolConnections.name));

  async function aiFailure(agent: AgentRow, binding: AiConnectionBinding, responsibleUserId: string, routed: boolean) {
    try {
      let effective = binding;
      let adapterType = agent.adapterType;
      let config = agent.adapterConfig ?? {};
      if (routed && route) {
        const routedAgent = applyAiAccessRoute(agent, route);
        adapterType = routedAgent.adapterType;
        config = routedAgent.adapterConfig;
        effective = await resolveAiAccessRouteBinding(db, { companyId, responsibleUserId, route });
      }
      await ai.select({
        companyId,
        userId: responsibleUserId,
        agentId: agent.id,
        adapterType,
        model: config.model,
        runnerProvider: config.provider,
        acpxAgent: config.acpxAgent,
        binding: effective,
      });
      return null;
    } catch (error) {
      return errorMessage(error);
    }
  }

  const agentData = new Map<string, AgentPlanData>();
  for (const agent of agentRows) {
    const routed = Boolean(route) && (AI_ACCESS_ROUTABLE_ADAPTER_TYPES as readonly string[]).includes(agent.adapterType);
    const parsed = aiConnectionBindingSchema.safeParse(agent.runtimeConfig?.aiConnection);
    const binding = parsed.success ? parsed.data : null;
    if (!binding && !routed) continue;
    const onOwnAccount = Boolean(binding && binding.mode !== "responsible_user" && ownGrantIds.has(binding.grantId));
    const responsibleTargets = agentNewResponsible.get(agent.id);
    const usesResponsible = routed || binding?.mode === "responsible_user";
    if (!onOwnAccount && !(usesResponsible && responsibleTargets && responsibleTargets.size > 0)) continue;

    const targets = [...(responsibleTargets && responsibleTargets.size > 0 ? responsibleTargets : new Set([successorUserId]))];
    const provider = binding?.provider ?? (route ? applyAiAccessRoute(agent, route).runtimeConfig.aiConnection as AiConnectionBinding : null)?.provider;
    const personalBinding: AiConnectionBinding | null = binding
      ? { provider: binding.provider, method: binding.method, mode: "responsible_user" }
      : null;
    const personalFailures: string[] = [];
    for (const target of targets) {
      const failure = await aiFailure(agent, personalBinding ?? (binding as AiConnectionBinding), target, routed);
      if (failure) personalFailures.push(`${nameOf(target)}: ${failure}`);
    }
    const sharedAlternatives: MemberHandoverSharedAiAccount[] = [];
    if (!routed) {
      for (const shared of sharedAiRows) {
        const metadata = aiConnectionMetadataSchema.safeParse(shared.config?.ai);
        if (!metadata.success) continue;
        const candidate: AiConnectionBinding = {
          provider: metadata.data.provider,
          method: metadata.data.method,
          mode: "shared",
          connectionId: shared.connectionId,
          grantId: shared.grantId,
        };
        let works = true;
        for (const target of targets) {
          if (await aiFailure(agent, candidate, target, false)) {
            works = false;
            break;
          }
        }
        if (works) {
          sharedAlternatives.push({
            connectionId: shared.connectionId,
            grantId: shared.grantId,
            name: shared.name,
            provider: metadata.data.provider,
            method: metadata.data.method,
          });
        }
      }
    }

    const personalWorks = personalFailures.length === 0;
    const keepAction: MemberHandoverAction = usesResponsible ? { type: "keep_ai_setting" } : { type: "use_personal_default" };
    const recommended: MemberHandoverAction = personalWorks
      ? keepAction
      : sharedAlternatives[0]
        ? { type: "use_shared_connection", ...sharedAlternatives[0] }
        : keepAction;
    const choices: MemberHandoverChoice[] = routed ? [] : ["use_personal_default", "use_shared_connection"];
    const ref = `agent:${agent.id}`;
    let { planned, blocker } = plannedFor(ref, recommended, choices);
    if (planned.type === "use_personal_default" && usesResponsible) planned = keepAction;
    if (planned.type === "use_shared_connection") {
      const wantedGrantId = planned.grantId;
      const chosen = sharedAlternatives.find((entry) => entry.grantId === wantedGrantId);
      if (chosen) planned = { type: "use_shared_connection", ...chosen };
      else blocker ??= "That shared AI account is not available to this agent.";
    }
    const targetNames = targets.map(nameOf).join(", ");
    const label = providerName(provider ?? "ai");
    if (!blocker && (planned.type === "keep_ai_setting" || planned.type === "use_personal_default") && !personalWorks) {
      blocker = sharedAlternatives.length > 0
        ? `${agent.name} would have no working AI account on ${targetNames}'s default ${label} account (${personalFailures.join("; ")}). Choose a shared account for it.`
        : `${agent.name} would have no AI account: ${targetNames} has no usable default ${label} account and no shared ${label} account is available to this agent (${personalFailures.join("; ")}). Ask ${targetNames} to connect one in Apps, or connect a shared account, then try again.`;
    }
    agentData.set(agent.id, { agent, binding, routed });
    items.push({
      ref,
      group: "agents",
      kind: "agent_ai",
      title: agent.name,
      detail: onOwnAccount
        ? `Runs on ${leaver.name}'s own ${label} account, which is revoked when they leave.`
        : routed
          ? `Install-wide AI access route: runs use the responsible person's default ${label} account or a shared one.`
          : `Runs on the responsible person's default ${label} account. Its work moves to ${targetNames}.`,
      link: `/agents/${agent.id}`,
      recommended,
      planned,
      choices,
      sharedAlternatives,
      blocker,
      warning: null,
    });
  }

  // --- Connections ------------------------------------------------------------
  for (const grant of grantRows) {
    const github = isGithubConnection(grant.config ?? {}, grant.transportConfig ?? {});
    const kind = grant.purpose === "ai" ? "ai_connection" : github ? "github_identity" : "tool_connection";
    const what = kind === "ai_connection" ? "AI account" : kind === "github_identity" ? "GitHub identity" : grant.purpose === "channel" ? "channel connection" : "tool connection";
    items.push({
      ref: `grant:${grant.id}`,
      group: "connections",
      kind,
      title: grant.connectionName,
      detail: `${leaver.name}'s personal ${what}. Personal credentials cannot be handed over, so it is revoked.`,
      link: null,
      recommended: { type: "revoke" },
      planned: { type: "revoke" },
      choices: [],
      blocker: null,
      warning: null,
    });
    if (grant.status === "active") {
      if (kind === "ai_connection") {
        const metadata = aiConnectionMetadataSchema.safeParse(grant.config?.ai);
        const label = metadata.success ? providerName(metadata.data.provider) : "AI";
        reconnect.push({ kind: "ai", name: grant.connectionName, detail: `Connect your own ${label} account in Apps and make it your default if agents ran on ${leaver.name}'s.` });
      } else if (kind === "github_identity") {
        reconnect.push({ kind: "github", name: grant.connectionName, detail: "Connect your own GitHub account so agents working for you can use it." });
      } else {
        reconnect.push({ kind: grant.purpose === "channel" ? "channel" : "tool", name: grant.connectionName, detail: `Reconnect ${grant.connectionName} with your own account if the team still needs it.` });
      }
    }
  }
  if (audienceRows.length > 0) {
    items.push({
      ref: "connection_audience",
      group: "connections",
      kind: "connection_audience",
      title: "Shared connection access",
      detail: `Named on ${plural(audienceRows.length, "shared connection")}. Removed.`,
      link: null,
      count: audienceRows.length,
      recommended: { type: "remove" },
      planned: { type: "remove" },
      choices: [],
      blocker: null,
      warning: null,
    });
  }

  // --- Access -------------------------------------------------------------------
  const memoryGrants = permissionRows.filter((row) => row.permissionKey.startsWith("memory:"));
  const otherGrants = permissionRows.filter((row) => !row.permissionKey.startsWith("memory:"));
  if (memoryGrants.length > 0) {
    items.push({
      ref: "memory_grants",
      group: "access",
      kind: "memory_grants",
      title: "Memory rights",
      detail: memoryGrants.map((row) => row.permissionKey).join(", "),
      link: null,
      count: memoryGrants.length,
      recommended: { type: "remove" },
      planned: { type: "remove" },
      choices: [],
      blocker: null,
      warning: null,
    });
  }
  if (otherGrants.length > 0) {
    items.push({
      ref: "permission_grants",
      group: "access",
      kind: "permission_grants",
      title: "Permissions",
      detail: `${plural(otherGrants.length, "permission")}. Removed; a restore puts them back.`,
      link: null,
      count: otherGrants.length,
      recommended: { type: "remove" },
      planned: { type: "remove" },
      choices: [],
      blocker: null,
      warning: null,
    });
  }
  const role = member.membershipRole ?? "operator";
  const membershipTo: "archived" | "suspended" =
    role === "owner" || role === "admin" || userId === LEGACY_BOARD_USER_ID ? "suspended" : "archived";
  items.push({
    ref: "membership",
    group: "access",
    kind: "membership",
    title: `Membership (${role})`,
    detail: membershipTo === "archived"
      ? "Archived: leaves pickers, defaults and the member list."
      : "Suspended: owners and admins keep their role on record but lose all access.",
    link: null,
    recommended: { type: membershipTo === "archived" ? "archive" : "suspend" },
    planned: { type: membershipTo === "archived" ? "archive" : "suspend" },
    choices: [],
    blocker: null,
    warning: null,
  });

  let instanceAdmin: PlanInternals["instanceAdmin"] = "not_held";
  if (adminRoles.length > 0) {
    let blocker: string | null = null;
    if (userId === LEGACY_BOARD_USER_ID && signInAccounts.length === 0 && !input.removeInstanceAdmin) {
      // Nobody can sign in as local-board; with keys revoked and sessions ended
      // nothing can act as it, so the role is kept (as the retirement did).
      instanceAdmin = "kept";
    } else if (!input.removeInstanceAdmin) {
      blocker = `${leaver.name} is an instance admin, so removing company access alone would not stop them. Confirm removing the instance admin role (owners only) to continue.`;
    } else if (caller.role !== "owner") {
      blocker = "Only an owner can remove an instance admin role.";
    } else if (otherAdmins.length === 0) {
      blocker = `${leaver.name} is the only instance admin. Make someone else an instance admin first.`;
    } else {
      instanceAdmin = "remove";
    }
    items.push({
      ref: "instance_admin",
      group: "access",
      kind: "instance_admin",
      title: "Instance admin role",
      detail: instanceAdmin === "kept"
        ? "Kept: this account has no sign-in, and its keys and sessions are switched off."
        : "Covers every company on this install.",
      link: null,
      recommended: { type: instanceAdmin === "kept" ? "keep" : "remove" },
      planned: { type: instanceAdmin === "kept" ? "keep" : "remove" },
      choices: [],
      blocker,
      warning: null,
    });
  }

  const revokeKeys = userId === LEGACY_BOARD_USER_ID || otherCompanies.length === 0;
  if (liveKeys.length > 0) {
    items.push({
      ref: "board_api_keys",
      group: "access",
      kind: "board_api_keys",
      title: "Board API keys",
      detail: revokeKeys
        ? `${plural(liveKeys.length, "key")} revoked.`
        : `${plural(liveKeys.length, "key")} kept: they still belong to ${plural(otherCompanies.length, "other company", "other companies")}, and keys cover the whole install.`,
      link: null,
      count: liveKeys.length,
      recommended: { type: revokeKeys ? "revoke" : "keep" },
      planned: { type: revokeKeys ? "revoke" : "keep" },
      choices: [],
      blocker: null,
      warning: revokeKeys ? null : "Their board API keys still work for their other companies.",
    });
  }
  if (sessions.length > 0) {
    items.push({
      ref: "sessions",
      group: "access",
      kind: "sessions",
      title: "Sign-in sessions",
      detail: `${plural(sessions.length, "session")} ended. They are signed out everywhere on this install.`,
      link: null,
      count: sessions.length,
      recommended: { type: "end" },
      planned: { type: "end" },
      choices: [],
      blocker: null,
      warning: null,
    });
  }

  for (const ref of overrides.keys()) {
    if (!usedRefs.has(ref)) blockers.push(`Unknown item "${ref}" in overrides.`);
  }
  for (const item of items) {
    if (item.blocker) blockers.push(`${item.title}: ${item.blocker}`);
    if (item.warning) warnings.push(`${item.title}: ${item.warning}`);
  }

  const countPlanned = (kind: MemberHandoverItem["kind"], skip: string[] = ["leave"]) =>
    items.filter((item) => item.kind === kind && !skip.includes(item.planned.type)).length;
  const counts: Record<string, number> = {
    issues: countPlanned("issue"),
    issuesClosed: items.filter((item) => item.kind === "issue" && item.planned.type === "close").length,
    interactions: countPlanned("interaction"),
    routines: countPlanned("routine"),
    agentsRepointed: items.filter((item) => item.kind === "agent_ai"
      && (item.planned.type === "use_shared_connection" || item.planned.type === "use_personal_default")).length,
    queuedRuns: queuedRuns.length,
    connectionsRevoked: grantRows.length,
    memoryGrantsRemoved: memoryGrants.length,
    permissionGrantsRemoved: otherGrants.length,
    boardKeysRevoked: revokeKeys ? liveKeys.length : 0,
    sessionsEnded: sessions.length,
  };

  const plan: MemberHandoverPlan = {
    dryRun: input.dryRun,
    companyId,
    member: {
      membershipId: member.id,
      userId,
      name: leaver.name,
      email: leaver.email,
      role: member.membershipRole,
      status: member.status,
      isInstanceAdmin: adminRoles.length > 0,
    },
    successor: { userId: successorUserId, name: successorName },
    items,
    blockers,
    warnings,
    reconnect,
    counts,
    handoverIssue: null,
  };
  return {
    plan,
    internals: {
      member,
      userId,
      work,
      interactions,
      routines: routineRows,
      agents: agentData,
      defaultResponsible,
      queuedRunCount: queuedRuns.length,
      grants: grantRows,
      permissionGrants: permissionRows.map((row) => ({ permissionKey: row.permissionKey, scope: row.scope ?? null })),
      membershipTo,
      instanceAdmin,
      revokeKeys,
      companyPrefix: company.prefix,
      names,
    },
  };
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

async function loadMember(db: DbReader, companyId: string, memberId: string) {
  const [member] = await db
    .select()
    .from(companyMemberships)
    .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.id, memberId)))
    .limit(1);
  if (!member) throw notFound("Member not found");
  return member;
}

function itemByRef(plan: MemberHandoverPlan) {
  return new Map(plan.items.map((item) => [item.ref, item]));
}

async function applyIssueMoves(tx: Tx, companyId: string, userId: string, successorUserId: string, plan: MemberHandoverPlan, work: OpenWorkForUser) {
  const byRef = itemByRef(plan);
  const now = new Date();
  for (const issue of work.issues) {
    const planned = byRef.get(`issue:${issue.id}`)?.planned;
    if (!planned || planned.type === "leave") continue;
    if (planned.type === "close") {
      await tx.update(issues).set({
        status: "cancelled",
        cancelledAt: now,
        checkoutRunId: null,
        executionRunId: null,
        executionLockedAt: null,
        updatedAt: now,
      }).where(and(eq(issues.companyId, companyId), eq(issues.id, issue.id)));
      continue;
    }
    const holder = planned.type === "move_to_user" ? planned.userId : successorUserId;
    const patch: Partial<typeof issues.$inferInsert> = {
      responsibleUserId: issue.responsibleUserId === userId ? holder : issue.responsibleUserId,
      executionState: rebindExecutionState(issue.executionState, holder, userId) as never,
      executionPolicy: rebindExecutionPolicy(issue.executionPolicy, holder, userId) as never,
      updatedAt: now,
    };
    if (issue.assigneeUserId === userId) {
      if (planned.type === "move_to_user") {
        patch.assigneeUserId = planned.userId;
      } else {
        // Same reset as archiving a member: work taken off a person goes back to todo.
        patch.assigneeUserId = null;
        patch.assigneeAgentId = planned.type === "move_to_agent" ? planned.agentId : null;
        if (issue.status === "in_progress") {
          Object.assign(patch, { status: "todo", startedAt: null, checkoutRunId: null, executionRunId: null, executionLockedAt: null });
        }
      }
    }
    await tx.update(issues).set(patch).where(and(eq(issues.companyId, companyId), eq(issues.id, issue.id)));
  }
}

async function applyRoutineMoves(tx: Tx, companyId: string, userId: string, plan: MemberHandoverPlan, rows: RoutineRow[]) {
  const byRef = itemByRef(plan);
  const now = new Date();
  for (const routine of rows) {
    const planned = byRef.get(`routine:${routine.id}`)?.planned;
    if (!planned || planned.type !== "move_to_user") continue;
    const to = planned.userId;
    if (routine.responsibleUserId === userId) {
      await tx.update(routines).set({ responsibleUserId: to, updatedAt: now })
        .where(and(eq(routines.companyId, companyId), eq(routines.id, routine.id)));
    }
    if (routine.latestRevisionId) {
      const snapshot = routine.revisionSnapshot as RoutineRevisionSnapshotV1 | null;
      const snapshotNamesUser = snapshotResponsibleUserId(snapshot) === userId;
      if (routine.revisionResponsibleUserId === userId || snapshotNamesUser) {
        await tx.update(routineRevisions).set({
          responsibleUserId: routine.revisionResponsibleUserId === userId ? to : routine.revisionResponsibleUserId,
          ...(snapshotNamesUser && snapshot
            ? { snapshot: { ...snapshot, routine: { ...snapshot.routine, responsibleUserId: to } } }
            : {}),
        }).where(and(eq(routineRevisions.companyId, companyId), eq(routineRevisions.id, routine.latestRevisionId)));
      }
    }
    // Runs already fired whose execution task is still open read their own
    // responsible person first, so they move too.
    await tx.update(routineRuns).set({ responsibleUserId: to, updatedAt: now }).where(and(
      eq(routineRuns.companyId, companyId),
      eq(routineRuns.routineId, routine.id),
      eq(routineRuns.responsibleUserId, userId),
      inArray(routineRuns.status, OPEN_ROUTINE_RUN_STATUSES),
    ));
  }
}

async function applyQueuedRunMoves(tx: Tx, companyId: string, userId: string, successorUserId: string) {
  // A retry reads its origin run's responsible person before its own, so the
  // origin of a queued retry moves as well.
  await tx.execute(sql`
    update ${heartbeatRuns}
    set responsible_user_id = ${successorUserId}, updated_at = now()
    where ${heartbeatRuns.companyId} = ${companyId}
      and ${heartbeatRuns.responsibleUserId} = ${userId}
      and ${heartbeatRuns.id}::text in (
        select context_snapshot ->> 'retryOfRunId' from ${heartbeatRuns}
        where ${heartbeatRuns.companyId} = ${companyId}
          and ${heartbeatRuns.status} in ('queued', 'scheduled_retry')
          and context_snapshot ->> 'retryOfRunId' is not null
      )
  `);
  await tx.execute(sql`
    update ${heartbeatRuns}
    set responsible_user_id = ${successorUserId},
        context_snapshot = case
          when context_snapshot ->> 'responsibleUserId' = ${userId}
            then jsonb_set(context_snapshot, '{responsibleUserId}', to_jsonb(${successorUserId}::text))
          else context_snapshot
        end,
        updated_at = now()
    where ${heartbeatRuns.companyId} = ${companyId}
      and ${heartbeatRuns.status} in ('queued', 'scheduled_retry')
      and ${heartbeatRuns.responsibleUserId} = ${userId}
  `);
}

async function applyAgentChanges(tx: Tx, companyId: string, actorUserId: string, plan: MemberHandoverPlan, internals: PlanInternals) {
  const byRef = itemByRef(plan);
  const changed: Array<{ agentId: string; name: string; to: string }> = [];
  for (const [agentId, data] of internals.agents) {
    const planned = byRef.get(`agent:${agentId}`)?.planned;
    if (!planned || !data.binding) continue;
    let next: AiConnectionBinding | null = null;
    if (planned.type === "use_personal_default" && data.binding.mode !== "responsible_user") {
      next = { provider: data.binding.provider, method: data.binding.method, mode: "responsible_user" };
    } else if (planned.type === "use_shared_connection") {
      const [row] = await tx.select({ config: toolConnections.config }).from(toolConnections)
        .where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.id, planned.connectionId)));
      const metadata = aiConnectionMetadataSchema.parse(row?.config?.ai);
      next = { provider: metadata.provider, method: metadata.method, mode: "shared", connectionId: planned.connectionId, grantId: planned.grantId };
    }
    if (!next) continue;
    const before = data.agent.runtimeConfig ?? {};
    const after = { ...before, aiConnection: next };
    await tx.update(agents).set({ runtimeConfig: after, updatedAt: new Date() })
      .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)));
    await tx.insert(agentConfigRevisions).values({
      companyId,
      agentId,
      createdByUserId: actorUserId,
      source: "member_handover",
      changedKeys: ["runtimeConfig"],
      beforeConfig: { runtimeConfig: before },
      afterConfig: { runtimeConfig: after },
    });
    changed.push({
      agentId,
      name: data.agent.name,
      to: planned.type === "use_shared_connection" ? `shared account ${planned.name}` : "the responsible person's default account",
    });
  }
  return changed;
}

function handoverDescription(plan: MemberHandoverPlan, internals: PlanInternals, actorName: string, agentChanges: Array<{ name: string; to: string }>) {
  const prefix = internals.companyPrefix;
  const issueLink = (item: MemberHandoverItem) => {
    const target = item.link?.replace(/^\/issues\//, "") ?? "";
    return `[${item.title}](/${prefix}/issues/${target})`;
  };
  const who = (action: MemberHandoverAction) =>
    action.type === "move_to_user" ? (internals.names.get(action.userId) ?? action.userId)
      : action.type === "move_to_agent" ? "an agent"
        : action.type;
  const lines: string[] = [];
  lines.push(`${plan.member.name}${plan.member.email ? ` (${plan.member.email})` : ""} has left the company. ${actorName} handed their work over to you on ${new Date().toISOString().slice(0, 10)}.`);
  lines.push("");
  const moved = plan.items.filter((item) => item.kind === "issue" && item.planned.type !== "leave" && item.planned.type !== "close");
  if (moved.length > 0) {
    lines.push("## Tasks moved");
    for (const item of moved) {
      const to = item.planned.type === "move_to_user" && item.planned.userId === plan.successor.userId ? "you" : who(item.planned);
      lines.push(`- ${issueLink(item)} (${(item.roles ?? []).map((role) => ROLE_LABEL[role] ?? role).join(", ")}) to ${to}`);
    }
    lines.push("");
  }
  const asks = plan.items.filter((item) => item.kind === "interaction" && item.planned.type !== "leave");
  if (asks.length > 0) {
    lines.push("## Questions and requests waiting for an answer");
    for (const item of asks) lines.push(`- ${item.title} on ${issueLink({ ...item, title: item.detail?.replace(/^.* on /, "") ?? item.title })}`);
    lines.push("");
  }
  const routineItems = plan.items.filter((item) => (item.kind === "routine" || item.kind === "company_default") && item.planned.type !== "leave");
  if (routineItems.length > 0) {
    lines.push("## Routines and defaults");
    for (const item of routineItems) {
      const label = item.kind === "routine" ? `[${item.title}](/${prefix}/routines/${item.ref.slice("routine:".length)})` : item.title;
      lines.push(`- ${label}: ${item.planned.type === "clear" ? "cleared" : `now ${who(item.planned) === plan.successor.name ? "you" : who(item.planned)}`}`);
    }
    lines.push("");
  }
  if (agentChanges.length > 0 || plan.items.some((item) => item.kind === "agent_ai")) {
    lines.push("## Agents and AI accounts");
    for (const item of plan.items.filter((entry) => entry.kind === "agent_ai")) {
      const change = agentChanges.find((entry) => entry.name === item.title);
      lines.push(`- [${item.title}](/${prefix}/agents/${item.ref.slice("agent:".length)}): ${change ? `now uses ${change.to}` : "keeps its setting and now runs on your default account"}`);
    }
    lines.push("");
  }
  if (plan.reconnect.length > 0) {
    lines.push("## You need to reconnect");
    lines.push(`${plan.member.name}'s personal connections were revoked. Personal credentials cannot be handed over.`);
    for (const entry of plan.reconnect) lines.push(`- ${entry.name}: ${entry.detail}`);
    lines.push("");
  }
  const decisions = [
    ...plan.items.filter((item) => item.planned.type === "leave").map((item) => `${item.title}: left as it was, still names ${plan.member.name}`),
    ...plan.items.filter((item) => item.kind === "issue" && item.planned.type === "close").map((item) => `${item.title}: closed`),
    ...plan.warnings,
  ];
  if (decisions.length > 0) {
    lines.push("## Needs a decision");
    for (const entry of decisions) lines.push(`- ${entry}`);
    lines.push("");
  }
  lines.push("## Access removed");
  lines.push(`- Membership ${internals.membershipTo}`);
  lines.push(`- ${plural(plan.counts.connectionsRevoked ?? 0, "personal connection")} revoked, ${plural(plan.counts.memoryGrantsRemoved ?? 0, "memory right")} and ${plural(plan.counts.permissionGrantsRemoved ?? 0, "permission")} removed`);
  lines.push(`- ${plural(plan.counts.boardKeysRevoked ?? 0, "board API key")} revoked, ${plural(plan.counts.sessionsEnded ?? 0, "sign-in session")} ended`);
  if (internals.instanceAdmin === "remove") lines.push("- Instance admin role removed");
  return lines.join("\n");
}

export async function planOrExecuteMemberHandover(
  db: Db,
  input: {
    companyId: string;
    memberId: string;
    deploymentMode: DeploymentMode;
    actor: HandoverActor;
    successorUserId: string;
    overrides?: MemberHandoverOverride[];
    removeInstanceAdmin?: boolean;
    dryRun: boolean;
  },
): Promise<MemberHandoverPlan> {
  const caller = await resolveHandoverCaller(db, input);
  const base = {
    companyId: input.companyId,
    deploymentMode: input.deploymentMode,
    caller,
    successorUserId: input.successorUserId,
    overrides: input.overrides ?? [],
    removeInstanceAdmin: input.removeInstanceAdmin === true,
  };
  if (input.dryRun) {
    const member = await loadMember(db, input.companyId, input.memberId);
    return (await buildPlan(db, { ...base, member, dryRun: true })).plan;
  }

  const publications: ActivityPublication[] = [];
  const plan = await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    // Same lock order as archiving a member: owners first, then the row.
    await tx.execute(sql`
      select ${companyMemberships.id} from ${companyMemberships}
      where ${companyMemberships.companyId} = ${input.companyId}
        and ${companyMemberships.principalType} = 'user'
        and ${companyMemberships.status} = 'active'
        and ${companyMemberships.membershipRole} = 'owner'
      for update
    `);
    const [member] = await tx.select().from(companyMemberships)
      .where(and(eq(companyMemberships.companyId, input.companyId), eq(companyMemberships.id, input.memberId)))
      .for("update");
    if (!member) throw notFound("Member not found");
    const { plan, internals } = await buildPlan(txDb, { ...base, member, dryRun: false });
    if (plan.blockers.length > 0) {
      throw unprocessable("This handover is blocked. Resolve the blockers and try again.", {
        code: "member_handover_blocked",
        blockers: plan.blockers,
      });
    }
    const { userId } = internals;
    const successorUserId = input.successorUserId;
    const byRef = itemByRef(plan);
    const now = new Date();

    await applyIssueMoves(tx, input.companyId, userId, successorUserId, plan, internals.work);
    for (const interaction of internals.interactions) {
      const planned = byRef.get(`interaction:${interaction.id}`)?.planned;
      if (planned?.type !== "move_to_user") continue;
      await tx.update(issueThreadInteractions).set({ addresseeUserId: planned.userId, updatedAt: now }).where(and(
        eq(issueThreadInteractions.companyId, input.companyId),
        eq(issueThreadInteractions.id, interaction.id),
        eq(issueThreadInteractions.status, "pending"),
        eq(issueThreadInteractions.addresseeUserId, userId),
      ));
    }
    await applyRoutineMoves(tx, input.companyId, userId, plan, internals.routines);
    if (internals.defaultResponsible) {
      const planned = byRef.get("company_default")?.planned;
      await tx.update(companies).set({
        defaultResponsibleUserId: planned?.type === "move_to_user" ? planned.userId : null,
        updatedAt: now,
      }).where(eq(companies.id, input.companyId));
    }
    if (internals.queuedRunCount > 0) await applyQueuedRunMoves(tx, input.companyId, userId, successorUserId);
    const agentChanges = await applyAgentChanges(tx, input.companyId, caller.userId, plan, internals);

    await accessService(txDb).sweepMemberConnectionAccess(tx, input.companyId, userId, now);
    await tx.delete(principalPermissionGrants).where(and(
      eq(principalPermissionGrants.companyId, input.companyId),
      eq(principalPermissionGrants.principalType, "user"),
      eq(principalPermissionGrants.principalId, userId),
    ));
    await tx.update(companyMemberships).set({ status: internals.membershipTo, updatedAt: now })
      .where(eq(companyMemberships.id, member.id));
    if (internals.instanceAdmin === "remove") {
      await tx.delete(instanceUserRoles).where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")));
    }
    if (internals.revokeKeys) {
      await tx.update(boardApiKeys).set({ revokedAt: now })
        .where(and(eq(boardApiKeys.userId, userId), isNull(boardApiKeys.revokedAt)));
    }
    await tx.delete(authSessions).where(eq(authSessions.userId, userId));

    const actorName = (await loadUserNames(txDb, [caller.userId])).get(caller.userId)?.name ?? caller.userId;
    const title = `Handover from ${plan.member.name}`;
    const created = await issueService(txDb).create(input.companyId, {
      title,
      description: handoverDescription(plan, internals, actorName, agentChanges),
      status: "todo",
      priority: "high",
      assigneeUserId: successorUserId,
      responsibleUserId: successorUserId,
      trustExplicitResponsibleUserId: true,
      createdByUserId: caller.userId === LEGACY_BOARD_USER_ID ? null : caller.userId,
    }, tx as never);
    plan.handoverIssue = { id: created.id, identifier: created.identifier ?? null, title };
    plan.dryRun = false;

    await logActivity(txDb, {
      companyId: input.companyId,
      actorType: "user",
      actorId: caller.userId,
      action: MEMBER_HANDED_OVER_ACTION,
      entityType: "company_membership",
      entityId: member.id,
      details: {
        principalId: userId,
        successorUserId,
        membershipStatus: { from: member.status, to: internals.membershipTo },
        counts: plan.counts,
        issueIdentifiers: plan.items.filter((item) => item.kind === "issue").map((item) => item.title.split(" ")[0]),
        agentChanges,
        reconnect: plan.reconnect.map((entry) => entry.name),
        removedPermissionGrants: internals.permissionGrants.filter((grant) => !grant.permissionKey.startsWith("memory:")),
        removedMemoryGrants: internals.permissionGrants.filter((grant) => grant.permissionKey.startsWith("memory:")).map((grant) => grant.permissionKey),
        instanceAdmin: internals.instanceAdmin,
        instanceAdminRemoved: internals.instanceAdmin === "remove",
        boardKeysRevoked: internals.revokeKeys,
        handoverIssueId: created.id,
        warnings: plan.warnings,
      },
    }, publications);
    return plan;
  });
  for (const publication of publications) publishActivity(publication);
  return plan;
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export async function restoreHandedOverMember(
  db: Db,
  input: { companyId: string; memberId: string; deploymentMode: DeploymentMode; actor: HandoverActor },
): Promise<MemberHandoverRestoreResult> {
  const caller = await resolveHandoverCaller(db, input);
  const publications: ActivityPublication[] = [];
  const result = await db.transaction(async (tx) => {
    const [member] = await tx.select().from(companyMemberships)
      .where(and(eq(companyMemberships.companyId, input.companyId), eq(companyMemberships.id, input.memberId)))
      .for("update");
    if (!member) throw notFound("Member not found");
    const reason = restoreRefusalReason({ deploymentMode: input.deploymentMode, caller, member });
    if (reason) throw member.status === "archived" || member.status === "suspended" ? forbidden(reason) : conflict(reason);

    const [lastHandover] = await tx
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.entityId, member.id),
        inArray(activityLog.action, [MEMBER_HANDED_OVER_ACTION, "company_member.legacy_board_retired"]),
      ))
      .orderBy(desc(activityLog.createdAt))
      .limit(1);
    const details = (lastHandover?.details ?? null) as Record<string, unknown> | null;
    const now = new Date();
    await tx.update(companyMemberships).set({ status: "active", updatedAt: now }).where(eq(companyMemberships.id, member.id));

    // Permission grants the handover removed come back (memory rights are set
    // only through the owner route, so they are not). Without a record, the
    // role's default grants are given.
    let permissionGrantsRestored = 0;
    const removed = Array.isArray(details?.removedPermissionGrants)
      ? (details!.removedPermissionGrants as Array<{ permissionKey?: unknown; scope?: unknown }>)
        .filter((grant) => typeof grant.permissionKey === "string" && !String(grant.permissionKey).startsWith("memory:"))
      : null;
    if (removed && removed.length > 0) {
      const inserted = await tx.insert(principalPermissionGrants).values(removed.map((grant) => ({
        companyId: input.companyId,
        principalType: "user",
        principalId: member.principalId,
        permissionKey: String(grant.permissionKey),
        scope: (grant.scope && typeof grant.scope === "object" ? grant.scope : null) as Record<string, unknown> | null,
        grantedByUserId: caller.userId,
        createdAt: now,
        updatedAt: now,
      }))).onConflictDoNothing().returning({ id: principalPermissionGrants.id });
      permissionGrantsRestored = inserted.length;
    } else if (!removed) {
      permissionGrantsRestored = await ensureHumanRoleDefaultGrants(tx as unknown as Db, {
        companyId: input.companyId,
        principalId: member.principalId,
        membershipRole: member.membershipRole,
        grantedByUserId: caller.userId,
      });
    }

    let instanceAdminRestored = false;
    if (details?.instanceAdminRemoved === true) {
      const existing = await tx.select({ id: instanceUserRoles.id }).from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, member.principalId), eq(instanceUserRoles.role, "instance_admin")));
      if (existing.length === 0) {
        await tx.insert(instanceUserRoles).values({ userId: member.principalId, role: "instance_admin" });
        instanceAdminRestored = true;
      }
    }

    await logActivity(tx as unknown as Db, {
      companyId: input.companyId,
      actorType: "user",
      actorId: caller.userId,
      action: MEMBER_RESTORED_ACTION,
      entityType: "company_membership",
      entityId: member.id,
      details: { principalId: member.principalId, from: member.status, permissionGrantsRestored, instanceAdminRestored },
    }, publications);
    return {
      companyId: input.companyId,
      membershipId: member.id,
      userId: member.principalId,
      membershipStatus: { from: member.status, to: "active" as const },
      permissionGrantsRestored,
      instanceAdminRestored,
    };
  });
  for (const publication of publications) publishActivity(publication);
  return result;
}

/** The successor a fresh dialog suggests: the primary owner for local-board, else the caller. */
export async function suggestedSuccessorUserId(
  db: DbReader,
  input: { companyId: string; member: MembershipRow; callerUserId: string },
): Promise<string | null> {
  if (input.member.principalId === LEGACY_BOARD_USER_ID) return primaryOwnerUserId(db, input.companyId);
  return input.callerUserId === input.member.principalId ? null : input.callerUserId;
}
