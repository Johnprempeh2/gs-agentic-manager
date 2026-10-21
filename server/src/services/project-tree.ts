import { and, asc, eq, inArray, isNull, ne, notInArray, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { activityLog, agents, companies, issues, projects } from "@greatstone/db";
import type { ProjectTree } from "@greatstone/shared";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import type { CanReadIssue } from "./issue-follows.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import { buildTreeNodes, rowsOf, treeNodeColumns } from "./issue-tree.js";
import { issueService } from "./issues.js";
import { findLeadAgentId } from "./looks-finished.js";

// The project tree: key tasks drive a project, everything else sits under
// one of them. A person's new top-level task wakes one agent to place it; the
// project lead tidies the rest on request.

export const PROJECT_TREE_MAX_NODES = 300;
export const PROJECT_TREE_MAX_DEPTH = 12;
export const PROJECT_TASK_PLACEMENT_REASON = "project_task_placement";
export const PROJECT_TIDY_ORIGIN_KIND = "project_tidy";
export const PROJECT_LEAD_PROPOSAL_ORIGIN_KIND = "project_lead_proposal";
const PLACEMENT_ACTION = "issue.placement_requested";
const CLOSED = ["done", "cancelled"];
/** A tidy task lists at most this many tasks; the rest wait for the next one. */
const TIDY_LIST_LIMIT = 50;

type Json = Record<string, unknown>;

function json<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function label(issue: { identifier: string | null; title: string }) {
  return issue.identifier ? `${issue.identifier} ${issue.title}` : issue.title;
}

export type PlacementVia = "assignee" | "project_lead" | "company_lead";

export function projectTreeService(
  db: Db,
  deps: { heartbeat?: IssueAssignmentWakeupDeps; limits?: { maxNodes: number; maxDepth: number } } = {},
) {
  const limits = deps.limits ?? { maxNodes: PROJECT_TREE_MAX_NODES, maxDepth: PROJECT_TREE_MAX_DEPTH };

  async function liveAgentId(companyId: string, agentId: string | null) {
    if (!agentId) return null;
    const row = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId), ne(agents.status, "terminated")))
      .then((rows) => rows[0] ?? null);
    return row?.id ?? null;
  }

  /** The project's lead, or the company lead (Everest) covering for none. */
  async function resolveLead(project: { companyId: string; leadAgentId: string | null }) {
    const own = await liveAgentId(project.companyId, project.leadAgentId);
    if (own) return { agentId: own, covering: false };
    return { agentId: await findLeadAgentId(db, project.companyId), covering: true };
  }

  async function getProject(companyId: string, projectId: string) {
    return db
      .select({
        id: projects.id,
        companyId: projects.companyId,
        name: projects.name,
        status: projects.status,
        leadAgentId: projects.leadAgentId,
      })
      .from(projects)
      .where(and(eq(projects.companyId, companyId), eq(projects.id, projectId)))
      .then((rows) => rows[0] ?? null);
  }

  async function openTidyTaskId(companyId: string, projectId: string) {
    const row = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, PROJECT_TIDY_ORIGIN_KIND),
        eq(issues.originId, projectId),
        notInArray(issues.status, CLOSED),
        isNull(issues.hiddenAt),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row?.id ?? null;
  }

  /**
   * One pass over the project in SQL. Every task belongs to the branch of its
   * nearest key task (itself, when it is one) or to no branch ("Unsorted").
   * Done work is counted here and only open work, its way up to its branch,
   * and the key tasks themselves are sent back as ids.
   */
  async function shape(companyId: string, projectId: string, finished: boolean) {
    const result = await db.execute(sql`
      WITH RECURSIVE tree(id, depth, branch_key, path, open, is_key, status) AS (
        SELECT i.id, 0,
          CASE WHEN i.key_task_at IS NOT NULL THEN i.id END,
          ARRAY[i.id],
          i.status NOT IN ('done', 'cancelled'),
          i.key_task_at IS NOT NULL,
          i.status
        FROM issues i
        WHERE i.company_id = ${companyId}::uuid
          AND i.project_id = ${projectId}::uuid
          AND i.hidden_at IS NULL
          AND (
            i.parent_id IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM issues up
              WHERE up.id = i.parent_id
                AND up.company_id = ${companyId}::uuid
                AND up.project_id = ${projectId}::uuid
                AND up.hidden_at IS NULL
            )
          )
        UNION ALL
        SELECT c.id, t.depth + 1,
          CASE WHEN c.key_task_at IS NOT NULL THEN c.id ELSE t.branch_key END,
          CASE WHEN c.key_task_at IS NOT NULL THEN ARRAY[c.id] ELSE t.path || c.id END,
          c.status NOT IN ('done', 'cancelled'),
          c.key_task_at IS NOT NULL,
          c.status
        FROM issues c
        JOIN tree t ON c.parent_id = t.id
        WHERE c.company_id = ${companyId}::uuid
          AND c.project_id = ${projectId}::uuid
          AND c.hidden_at IS NULL
          AND t.depth < ${limits.maxDepth}
      ),
      kept AS (
        SELECT id FROM tree WHERE is_key OR ${finished}::boolean
        UNION
        SELECT unnest(path) FROM tree WHERE open
      ),
      kept_rows AS (
        SELECT t.id, t.depth, t.open FROM tree t JOIN kept k ON k.id = t.id
        ORDER BY t.depth, t.open DESC, t.id
        LIMIT ${limits.maxNodes + 1}
      ),
      folded AS (
        SELECT (
          SELECT p.anchor FROM unnest(t.path) WITH ORDINALITY AS p(anchor, ord)
          WHERE p.anchor IN (SELECT id FROM kept_rows)
          ORDER BY p.ord DESC LIMIT 1
        ) AS anchor
        FROM tree t
        WHERE t.id NOT IN (SELECT id FROM kept)
      )
      SELECT
        (SELECT coalesce(json_agg(json_build_object('id', id, 'depth', depth) ORDER BY depth, open DESC, id), '[]'::json)
          FROM kept_rows) AS kept,
        (SELECT coalesce(json_object_agg(anchor, n), '{}'::json)
          FROM (SELECT anchor, count(*)::int AS n FROM folded WHERE anchor IS NOT NULL GROUP BY anchor) f) AS folded,
        (SELECT coalesce(json_object_agg(branch_key, json_build_object('done', done, 'total', total)), '{}'::json)
          FROM (
            SELECT branch_key,
              count(*) FILTER (WHERE id <> branch_key AND status = 'done')::int AS done,
              count(*) FILTER (WHERE id <> branch_key AND status <> 'cancelled')::int AS total
            FROM tree WHERE branch_key IS NOT NULL GROUP BY branch_key
          ) g) AS progress,
        (SELECT json_build_object(
            'done', count(*) FILTER (WHERE status = 'done'),
            'active', count(*) FILTER (WHERE status IN ('in_progress', 'in_review')),
            'blocked', count(*) FILTER (WHERE status = 'blocked'),
            'waiting', count(*) FILTER (WHERE status NOT IN ('done', 'cancelled', 'in_progress', 'in_review', 'blocked')))
          FROM tree WHERE branch_key IS NOT NULL) AS counts,
        EXISTS (
          SELECT 1 FROM tree t
          JOIN issues c ON c.parent_id = t.id
          WHERE t.depth = ${limits.maxDepth}
            AND c.company_id = ${companyId}::uuid
            AND c.project_id = ${projectId}::uuid
            AND c.hidden_at IS NULL
        ) AS too_deep
    `);
    const row = rowsOf(result)[0] ?? {};
    const kept = json<Array<{ id: string; depth: number }>>(row.kept, []);
    return {
      kept: kept.slice(0, limits.maxNodes),
      truncated: kept.length > limits.maxNodes || row.too_deep === true,
      folded: json<Record<string, number>>(row.folded, {}),
      progress: json<Record<string, { done: number; total: number }>>(row.progress, {}),
      counts: json<ProjectTree["counts"]>(row.counts, { done: 0, active: 0, blocked: 0, waiting: 0 }),
    };
  }

  async function getTree(
    companyId: string,
    projectId: string,
    options: { finished?: boolean; canRead?: CanReadIssue } = {},
  ): Promise<ProjectTree | null> {
    const project = await getProject(companyId, projectId);
    if (!project) return null;
    const [lead, tidyTaskId, shaped] = await Promise.all([
      resolveLead(project),
      openTidyTaskId(companyId, projectId),
      shape(companyId, projectId, options.finished === true),
    ]);
    const depthById = new Map(shaped.kept.map((entry) => [entry.id, entry.depth]));
    const loaded = depthById.size
      ? await db
          .select(treeNodeColumns)
          .from(issues)
          .where(and(eq(issues.companyId, companyId), inArray(issues.id, [...depthById.keys()])))
      : [];
    const byId = new Map(loaded.map((row) => [row.id, row]));

    // Parents come first (ordered by depth), so a task the viewer cannot read
    // hides its whole branch.
    const candidates = new Set(depthById.keys());
    const kept: typeof loaded = [];
    const keptIds = new Set<string>();
    const ordered = shaped.kept.map((entry) => byId.get(entry.id)).filter((row) => row !== undefined);
    const readable = options.canRead ? await Promise.all(ordered.map((row) => options.canRead!(row))) : null;
    ordered.forEach((row, index) => {
      if (readable && !readable[index]) return;
      const branchTop = row.keyTaskAt != null || !row.parentId || !candidates.has(row.parentId);
      if (!branchTop && !keptIds.has(row.parentId!)) return;
      kept.push(row);
      keptIds.add(row.id);
    });

    // A key task is always a branch of the project; other work hangs under
    // its parent, or under "Unsorted" when it has none here.
    const parentIdOf = (row: (typeof kept)[number]) =>
      row.keyTaskAt == null && row.parentId && keptIds.has(row.parentId) ? row.parentId : null;
    const { nodes, externalBlockers } = await buildTreeNodes(db, companyId, kept, {
      depthOf: (row) => depthById.get(row.id) ?? 0,
      parentIdOf,
      canRead: options.canRead,
    });

    const pick = <T>(record: Record<string, T>) =>
      Object.fromEntries(Object.entries(record).filter(([id]) => keptIds.has(id)));
    return {
      project: { id: project.id, name: project.name, status: project.status, lead },
      keyTaskIds: kept.filter((row) => row.keyTaskAt != null).map((row) => row.id),
      unsortedIds: kept.filter((row) => row.keyTaskAt == null && parentIdOf(row) === null).map((row) => row.id),
      nodes,
      externalBlockers,
      hiddenDoneByParent: pick(shaped.folded),
      keyTaskProgress: pick(shaped.progress),
      counts: shaped.counts,
      openTidyTaskId: tidyTaskId,
      truncated: shaped.truncated,
      limits: { ...limits },
    };
  }

  /**
   * A person added a top-level task to a project: wake one agent to put it
   * where it belongs. The assignee agent first, else the project lead, else
   * the company lead. Once per task.
   */
  async function requestPlacement(issue: {
    id: string;
    companyId: string;
    projectId: string | null;
    parentId: string | null;
    identifier: string | null;
    title: string;
    assigneeAgentId: string | null;
    keyTaskAt?: Date | null;
  }, requestedByUserId: string | null) {
    if (!issue.projectId || issue.parentId || issue.keyTaskAt) return null;
    const already = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, issue.companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, issue.id),
        eq(activityLog.action, PLACEMENT_ACTION),
      ))
      .limit(1);
    if (already.length > 0) return null;
    const project = await getProject(issue.companyId, issue.projectId);
    if (!project) return null;

    let agentId = await liveAgentId(issue.companyId, issue.assigneeAgentId);
    let via: PlacementVia = "assignee";
    if (!agentId) {
      const lead = await resolveLead(project);
      agentId = lead.agentId;
      via = lead.covering ? "company_lead" : "project_lead";
    }
    if (!agentId) return null;

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "system",
      actorId: "project_tree",
      action: PLACEMENT_ACTION,
      entityType: "issue",
      entityId: issue.id,
      issueId: issue.id,
      agentId,
      details: {
        identifier: issue.identifier,
        projectId: project.id,
        via,
        reason: "A person added this task to the project with no parent; the agent places it in the project tree.",
        requestedByUserId,
      },
    });
    // A plain wake on the new task would read as "do this task". A small
    // placement task carries the instruction to any agent, skill or not.
    const placement = await issueService(db).create(issue.companyId, {
      title: `Place ${label(issue)} in the ${project.name} project tree`,
      description: [
        `A person added ${label(issue)} to the ${project.name} project with no parent. Do not start that task here; only place it.`,
        "",
        "Set its parent (parentId) to the key task or task it serves; add blocker links if it obviously waits on another task; or, if it is genuinely a new driver of the project, mark it a key task (keyTask: true). Leave a one-line comment on it saying where it went and why, then close this task.",
      ].join("\n"),
      status: "todo",
      priority: "low",
      assigneeAgentId: agentId,
      originKind: PROJECT_TASK_PLACEMENT_REASON,
      originId: issue.id,
    });
    if (deps.heartbeat) {
      await queueIssueAssignmentWakeup({
        heartbeat: deps.heartbeat,
        issue: placement,
        reason: PROJECT_TASK_PLACEMENT_REASON,
        mutation: "create",
        contextSource: "project.task_placement",
        requestedByActorType: "system",
        requestedByActorId: "project_tree",
      });
    }
    return { agentId, via };
  }

  async function closePlacementTasks(companyId: string, issueId: string) {
    await db
      .update(issues)
      .set({ status: "done", completedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, PROJECT_TASK_PLACEMENT_REASON),
        eq(issues.originId, issueId),
        notInArray(issues.status, CLOSED),
      ));
  }

  async function listUnplaced(companyId: string, projectId: string) {
    return db
      .select({ id: issues.id, identifier: issues.identifier, title: issues.title })
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.projectId, projectId),
        isNull(issues.parentId),
        isNull(issues.keyTaskAt),
        isNull(issues.hiddenAt),
        notInArray(issues.status, CLOSED),
      ))
      .orderBy(asc(issues.createdAt))
      .limit(TIDY_LIST_LIMIT + 1);
  }

  /**
   * "Tidy": one task for the project lead (or the company lead) listing the
   * open unplaced work to place in one run. Refused while one is open.
   */
  async function requestTidy(
    companyId: string,
    projectId: string,
    actor: { actorType: "user" | "agent"; actorId: string },
  ): Promise<
    | { status: "created"; taskId: string; agentId: string }
    | { status: "already_open"; taskId: string }
    | { status: "nothing_to_tidy" }
    | { status: "no_lead" }
    | null
  > {
    const project = await getProject(companyId, projectId);
    if (!project) return null;
    const open = await openTidyTaskId(companyId, projectId);
    if (open) return { status: "already_open", taskId: open };
    const unplaced = await listUnplaced(companyId, projectId);
    if (unplaced.length === 0) return { status: "nothing_to_tidy" };
    const lead = await resolveLead(project);
    if (!lead.agentId) return { status: "no_lead" };

    const shown = unplaced.slice(0, TIDY_LIST_LIMIT);
    const created = await issueService(db).create(companyId, {
      title: `Tidy the ${project.name} project tree (${shown.length}${unplaced.length > shown.length ? "+" : ""} unsorted)`,
      description: [
        `These open tasks in the ${project.name} project sit under no key task. Place each one in a single run.`,
        "",
        "For each task: set its parent (parentId) to the key task or task it serves; add blocker links where one obviously waits on another; or, if it is genuinely a new driver of the project, mark it a key task (keyTask: true). Leave a one-line comment on the task saying where it went and why.",
        "",
        ...shown.map((issue) => `- ${label(issue)}`),
        ...(unplaced.length > shown.length ? ["", "There are more; press Tidy again once this one is closed."] : []),
        "",
        "Keep 3 to 7 key tasks per project. Close this task when every task above is placed.",
      ].join("\n"),
      status: "todo",
      priority: "low",
      assigneeAgentId: lead.agentId,
      originKind: PROJECT_TIDY_ORIGIN_KIND,
      originId: projectId,
    });
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "project.tidy_requested",
      entityType: "project",
      entityId: projectId,
      agentId: lead.agentId,
      details: { taskId: created.id, unsorted: shown.length, covering: lead.covering },
    });
    if (deps.heartbeat) {
      await queueIssueAssignmentWakeup({
        heartbeat: deps.heartbeat,
        issue: created,
        reason: "project_tidy",
        mutation: "create",
        contextSource: "project.tidy",
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
      });
    }
    return { status: "created", taskId: created.id, agentId: lead.agentId };
  }

  /**
   * The company lead covers projects with no lead. Once per company, ever, it
   * gets a task listing them, to propose a lead for each to the board.
   */
  async function ensureLeadProposalTask(companyId: string) {
    const existing = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, PROJECT_LEAD_PROPOSAL_ORIGIN_KIND),
        eq(issues.originId, companyId),
      ))
      .limit(1);
    if (existing.length > 0) return null;
    const leaderless = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(and(eq(projects.companyId, companyId), isNull(projects.leadAgentId), isNull(projects.archivedAt)))
      .orderBy(asc(projects.name));
    if (leaderless.length === 0) return null;
    const leadAgentId = await findLeadAgentId(db, companyId);
    if (!leadAgentId) return null;
    const created = await issueService(db).create(companyId, {
      title: `Propose a lead for ${leaderless.length} project${leaderless.length === 1 ? "" : "s"}`,
      description: [
        "These projects have no lead, so you cover them: you place their unsorted tasks and keep their key tasks.",
        "",
        ...leaderless.map((project) => `- ${project.name}`),
        "",
        "For each project, propose the agent best placed to lead it, with one line on why, in a comment for the board to approve. Do not set the leads yourself.",
      ].join("\n"),
      status: "todo",
      priority: "low",
      assigneeAgentId: leadAgentId,
      originKind: PROJECT_LEAD_PROPOSAL_ORIGIN_KIND,
      originId: companyId,
    });
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "project_tree",
      action: "issue.created",
      entityType: "issue",
      entityId: created.id,
      issueId: created.id,
      agentId: leadAgentId,
      details: { originKind: PROJECT_LEAD_PROPOSAL_ORIGIN_KIND, projects: leaderless.length } satisfies Json,
    });
    if (deps.heartbeat) {
      await queueIssueAssignmentWakeup({
        heartbeat: deps.heartbeat,
        issue: created,
        reason: "project_lead_proposal",
        mutation: "create",
        contextSource: "project_tree",
        requestedByActorType: "system",
      });
    }
    return created;
  }

  /** Every company, for the hourly sweep; one company failing skips only it. */
  async function ensureLeadProposalTasks() {
    let created = 0;
    for (const { id } of await db.select({ id: companies.id }).from(companies)) {
      try {
        if (await ensureLeadProposalTask(id)) created += 1;
      } catch (err) {
        logger.error({ err, companyId: id }, "project lead proposal check failed for a company");
      }
    }
    return created;
  }

  return { getTree, resolveLead, requestPlacement, closePlacementTasks, requestTidy, ensureLeadProposalTask, ensureLeadProposalTasks };
}
