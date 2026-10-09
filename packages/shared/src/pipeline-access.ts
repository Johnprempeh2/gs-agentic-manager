import type { PermissionKey } from "./constants.js";

/**
 * Pipeline (CRM) access for an agent (GRE-1072). Three levels:
 * - view: see boards, cases, contacts and history (company access, no grant).
 * - work_cases: create and edit cases and contacts, move, claim, suggest,
 *   review when named as approver. Grant key `pipelines:cases`.
 * - administer: create, rename, archive pipelines; edit stages, moves and
 *   fields. Grant key `pipelines:write`, which also covers work_cases.
 *
 * Scope is "all pipelines" (`pipelineIds: null`, stored as a null grant
 * scope) or a picked list (stored as `{ pipelineIds: [...] }`).
 */
export const PIPELINE_ACCESS_LEVELS = ["view", "work_cases", "administer"] as const;
export type PipelineAccessLevel = (typeof PIPELINE_ACCESS_LEVELS)[number];

export const PIPELINE_CASES_PERMISSION_KEY = "pipelines:cases" as const satisfies PermissionKey;
export const PIPELINE_ADMIN_PERMISSION_KEY = "pipelines:write" as const satisfies PermissionKey;

export interface PipelineAccess {
  level: PipelineAccessLevel;
  /** null = all pipelines in the company. */
  pipelineIds: string[] | null;
}

export function pipelineAccessScopeIds(scope: Record<string, unknown> | null | undefined): string[] | null {
  if (!scope) return null;
  const raw = scope.pipelineIds;
  if (!Array.isArray(raw)) return null;
  const ids = raw.filter((value): value is string => typeof value === "string" && value.length > 0);
  return ids.length > 0 ? [...new Set(ids)] : null;
}

export function pipelineAccessGrantScope(pipelineIds: string[] | null): Record<string, unknown> | null {
  if (!pipelineIds || pipelineIds.length === 0) return null;
  return { pipelineIds: [...new Set(pipelineIds)] };
}

/**
 * Reads the effective level from an agent's grants. Administer wins over
 * work_cases; the scope reported is the scope of the winning grant.
 */
export function resolvePipelineAccess(
  grants: ReadonlyArray<{ permissionKey: string; scope?: Record<string, unknown> | null }>,
): PipelineAccess {
  const admin = grants.find((grant) => grant.permissionKey === PIPELINE_ADMIN_PERMISSION_KEY);
  if (admin) return { level: "administer", pipelineIds: pipelineAccessScopeIds(admin.scope) };
  const cases = grants.find((grant) => grant.permissionKey === PIPELINE_CASES_PERMISSION_KEY);
  if (cases) return { level: "work_cases", pipelineIds: pipelineAccessScopeIds(cases.scope) };
  return { level: "view", pipelineIds: null };
}
