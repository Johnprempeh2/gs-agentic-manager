// Copy a drafted strategy plan from one instance to another (GRE-1190, Strategy Board F12).
//
// The plan is drafted in the practice (workshop) instance and then moves to the
// client's own instance. The plan is the strategy cascade: every goal with a
// kind (vision, value, csf, pillar, objective, kpi, initiative) and its plan
// fields (KPI targets, initiative due dates and budgets). Nothing else moves:
// no plain goals, issues, comments, check-ins, KPI readings, agents or secrets.
//
// The company export/import does not fit here: it does not carry goals, and a
// client edition refuses import (`company.import` is hidden). So the copy
// reads and writes the two databases itself, like `applyAiRoute`.
//
// Each goal keeps its id. A re-run updates the goals it copied before and
// makes no duplicates; it never deletes a goal in the target.
//
// Owners: an agent owner never moves (agents stay in their instance). A person
// owner is matched by email to an active member of the target company (the
// users F11 adds). An owner with no match is listed; the goal still moves.

import type { createDb } from "../../packages/db/src/index.js";

export type Sql = ReturnType<typeof createDb>["$client"];
/** A goal column as the instance database client reads and writes it (dates come as text). */
type Cell = string | number | null;

/** Goal columns that are plan data and move as they are. */
export const PLAN_FIELDS = [
  "title",
  "description",
  "level",
  "kind",
  "status",
  "target_date",
  "done_when",
  "target_value",
  "current_value",
  "unit",
  "baseline_value",
  "baseline_date",
  "kpi_direction",
  "amber_threshold_pct",
  "red_threshold_pct",
  "budget_planned_cents",
  "budget_spent_cents",
  "budget_currency",
  "benchmark_note",
] as const;

export interface PlanGoal {
  id: string;
  parent_id: string | null;
  owner_user_id: string | null;
  owner_agent_id: string | null;
  owner_email: string | null;
  created_at: unknown;
  [field: string]: unknown;
}

export interface UnmatchedOwner {
  goalId: string;
  title: string;
  kind: string;
  /** "person <email>", "person (no email)" or "agent". */
  owner: string;
}

export interface PlanCopyReport {
  total: number;
  byKind: Record<string, number>;
  created: number;
  updated: number;
  unchanged: number;
  matchedOwners: number;
  unmatchedOwners: UnmatchedOwner[];
  /** Goals whose parent is not plan data (a plain goal); they move as top-level goals. */
  detachedFromParent: string[];
}

export interface PlanCopyOptions {
  sourceCompanyId: string;
  targetCompanyId: string;
  /** false: read both sides and report; write nothing. */
  apply: boolean;
}

export async function companyIds(sql: Sql): Promise<Array<{ id: string; name: string }>> {
  return await sql<Array<{ id: string; name: string }>>`SELECT id, name FROM companies ORDER BY created_at`;
}

/** The cascade of one company, parents before children. */
export async function readPlan(sql: Sql, companyId: string): Promise<PlanGoal[]> {
  const rows = await sql<PlanGoal[]>`
    SELECT g.*, u.email AS owner_email
    FROM goals g
    LEFT JOIN "user" u ON u.id = g.owner_user_id
    WHERE g.company_id = ${companyId} AND g.kind IS NOT NULL
    ORDER BY g.created_at, g.id`;
  return parentsFirst(rows);
}

export function parentsFirst(rows: PlanGoal[]): PlanGoal[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const depth = new Map<string, number>();
  const depthOf = (row: PlanGoal, seen: Set<string>): number => {
    const known = depth.get(row.id);
    if (known !== undefined) return known;
    const parent = row.parent_id ? byId.get(row.parent_id) : undefined;
    if (!parent || seen.has(parent.id)) {
      if (parent) throw new Error(`goal ${row.id} is in a parent loop`);
      depth.set(row.id, 0);
      return 0;
    }
    seen.add(row.id);
    const value = depthOf(parent, seen) + 1;
    depth.set(row.id, value);
    return value;
  };
  for (const row of rows) depthOf(row, new Set([row.id]));
  // Stable: same depth keeps the read order.
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => depth.get(a.row.id)! - depth.get(b.row.id)! || a.index - b.index)
    .map(({ row }) => row);
}

const sameValue = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);

/**
 * Copy the plan of `sourceCompanyId` into `targetCompanyId`. With `apply`, the
 * write is one transaction: all of the plan moves, or none of it.
 */
export async function copyPlan(source: Sql, target: Sql, options: PlanCopyOptions): Promise<PlanCopyReport> {
  const plan = await readPlan(source, options.sourceCompanyId);
  const planIds = new Set(plan.map((goal) => goal.id));

  const run = async (tx: Sql): Promise<PlanCopyReport> => {
    const members = await tx<Array<{ id: string; email: string }>>`
      SELECT u.id, u.email
      FROM company_memberships m
      JOIN "user" u ON u.id = m.principal_id
      WHERE m.company_id = ${options.targetCompanyId} AND m.principal_type = 'user' AND m.status = 'active'`;
    const userByEmail = new Map(members.map((m) => [m.email.trim().toLowerCase(), m.id]));

    const ids = plan.map((goal) => goal.id);
    const existing = ids.length
      ? await tx<PlanGoal[]>`SELECT * FROM goals WHERE id IN ${tx(ids)}`
      : [];
    const existingById = new Map(existing.map((row) => [row.id, row]));
    const foreign = existing.find((row) => row.company_id !== options.targetCompanyId);
    if (foreign) {
      throw new Error(`goal ${foreign.id} already exists in another company of the target; nothing was copied`);
    }

    const report: PlanCopyReport = {
      total: plan.length,
      byKind: {},
      created: 0,
      updated: 0,
      unchanged: 0,
      matchedOwners: 0,
      unmatchedOwners: [],
      detachedFromParent: [],
    };

    for (const goal of plan) {
      const kind = String(goal.kind);
      report.byKind[kind] = (report.byKind[kind] ?? 0) + 1;
      const before = existingById.get(goal.id);

      const parentId = goal.parent_id && planIds.has(goal.parent_id) ? goal.parent_id : null;
      if (goal.parent_id && !parentId) report.detachedFromParent.push(goal.id);

      // Person owner by email. No match keeps what the target has (a re-run
      // never clears an owner set in the client instance).
      const matched = goal.owner_email ? userByEmail.get(goal.owner_email.trim().toLowerCase()) : undefined;
      let ownerUserId = before?.owner_user_id ?? null;
      let ownerAgentId = before?.owner_agent_id ?? null;
      if (matched) {
        report.matchedOwners += 1;
        ownerUserId = matched;
        ownerAgentId = null;
      } else if (goal.owner_user_id || goal.owner_agent_id) {
        report.unmatchedOwners.push({
          goalId: goal.id,
          title: String(goal.title),
          kind,
          owner: goal.owner_agent_id ? "agent" : goal.owner_email ? `person ${goal.owner_email}` : "person (no email)",
        });
      }

      const row: Record<string, Cell> = { parent_id: parentId, owner_user_id: ownerUserId, owner_agent_id: ownerAgentId };
      for (const field of PLAN_FIELDS) row[field] = (goal[field] ?? null) as Cell;

      if (!before) {
        report.created += 1;
        if (options.apply) {
          await tx`INSERT INTO goals ${tx({ ...row, id: goal.id, company_id: options.targetCompanyId, created_at: goal.created_at as Cell })}`;
        }
        continue;
      }
      if (Object.keys(row).every((key) => sameValue(row[key], before[key]))) {
        report.unchanged += 1;
        continue;
      }
      report.updated += 1;
      if (options.apply) {
        await tx`UPDATE goals SET ${tx({ ...row, updated_at: new Date().toISOString() })} WHERE id = ${goal.id}`;
      }
    }
    return report;
  };

  if (!options.apply) return await run(target);
  return (await target.begin((tx) => run(tx as unknown as Sql))) as PlanCopyReport;
}

export function planCopyLines(report: PlanCopyReport): string[] {
  const kinds = Object.entries(report.byKind)
    .map(([kind, count]) => `${kind} ${count}`)
    .join(", ");
  const lines = [
    `plan goals: ${report.total}${kinds ? ` (${kinds})` : ""}`,
    `created ${report.created}, updated ${report.updated}, unchanged ${report.unchanged}`,
    `owners matched by email: ${report.matchedOwners}`,
  ];
  if (report.unmatchedOwners.length === 0) {
    lines.push("unmatched owners: none");
  } else {
    lines.push(`unmatched owners: ${report.unmatchedOwners.length} (the goals moved without an owner; add the user, then run again)`);
    for (const o of report.unmatchedOwners) lines.push(`  - ${o.kind} "${o.title}": ${o.owner}`);
  }
  if (report.detachedFromParent.length > 0) {
    lines.push(`${report.detachedFromParent.length} goal(s) had a plain (non-plan) parent and moved as top-level goals`);
  }
  return lines;
}
