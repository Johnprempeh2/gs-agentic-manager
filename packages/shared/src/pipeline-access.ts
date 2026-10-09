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

type PipelineGrantLike = { permissionKey: string; scope?: Record<string, unknown> | null };

function grantCoversPipeline(grant: PipelineGrantLike | undefined, pipelineId: string) {
  if (!grant) return false;
  const ids = pipelineAccessScopeIds(grant.scope);
  return ids === null || ids.includes(pipelineId);
}

/**
 * The level an agent has on one pipeline (GRE-1073). An agent may hold
 * Administer on some pipelines and Work cases on others, so this reads both
 * grants rather than the single winning one.
 */
export function pipelineAccessLevelFor(
  grants: ReadonlyArray<PipelineGrantLike>,
  pipelineId: string,
): PipelineAccessLevel {
  const admin = grants.find((grant) => grant.permissionKey === PIPELINE_ADMIN_PERMISSION_KEY);
  if (grantCoversPipeline(admin, pipelineId)) return "administer";
  const cases = grants.find((grant) => grant.permissionKey === PIPELINE_CASES_PERMISSION_KEY);
  if (grantCoversPipeline(cases, pipelineId)) return "work_cases";
  return "view";
}

/** A grant after a change: absent, all pipelines (null), or a picked list. */
export type PipelineGrantScopeState = { granted: false } | { granted: true; pipelineIds: string[] | null };

function grantState(grant: PipelineGrantLike | undefined): PipelineGrantScopeState {
  if (!grant) return { granted: false };
  return { granted: true, pipelineIds: pipelineAccessScopeIds(grant.scope) };
}

function addPipeline(state: PipelineGrantScopeState, pipelineId: string): PipelineGrantScopeState {
  if (!state.granted) return { granted: true, pipelineIds: [pipelineId] };
  if (state.pipelineIds === null || state.pipelineIds.includes(pipelineId)) return state;
  return { granted: true, pipelineIds: [...state.pipelineIds, pipelineId] };
}

function removePipeline(
  state: PipelineGrantScopeState,
  pipelineId: string,
  companyPipelineIds: ReadonlyArray<string>,
): PipelineGrantScopeState {
  if (!state.granted) return state;
  // "All pipelines" minus one becomes the picked list of every other pipeline.
  const current = state.pipelineIds ?? [...companyPipelineIds];
  const next = current.filter((id) => id !== pipelineId);
  return next.length > 0 ? { granted: true, pipelineIds: next } : { granted: false };
}

/**
 * Plans the two grants after setting an agent's level on one pipeline
 * (GRE-1073). Other pipelines keep their level. Administer adds the pipeline
 * to `pipelines:write`; Work cases moves it from `pipelines:write` to
 * `pipelines:cases`; View removes it from both. An "all pipelines" grant that
 * loses one pipeline becomes a picked list of the company's other pipelines.
 */
export function planPipelineLevelChange(
  grants: ReadonlyArray<PipelineGrantLike>,
  pipelineId: string,
  level: PipelineAccessLevel,
  companyPipelineIds: ReadonlyArray<string>,
): { cases: PipelineGrantScopeState; write: PipelineGrantScopeState } {
  let cases = grantState(grants.find((grant) => grant.permissionKey === PIPELINE_CASES_PERMISSION_KEY));
  let write = grantState(grants.find((grant) => grant.permissionKey === PIPELINE_ADMIN_PERMISSION_KEY));
  if (level === "administer") {
    write = addPipeline(write, pipelineId);
  } else if (level === "work_cases") {
    write = removePipeline(write, pipelineId, companyPipelineIds);
    cases = addPipeline(cases, pipelineId);
  } else {
    write = removePipeline(write, pipelineId, companyPipelineIds);
    cases = removePipeline(cases, pipelineId, companyPipelineIds);
  }
  return { cases, write };
}

/** Who last changed an agent's pipeline access, from the activity log. */
export interface PipelineAccessLastChange {
  at: string;
  actorType: string;
  actorId: string;
  actorName: string | null;
}

export interface PipelineAccessMatrixAgent {
  agentId: string;
  name: string;
  role: string;
  status: string;
  /** Level per pipeline id. Every listed pipeline has an entry. */
  levels: Record<string, PipelineAccessLevel>;
  /** The level when it is the same "all pipelines" grant, else null (mixed or picked). */
  allPipelinesLevel: PipelineAccessLevel | null;
  /** Latest change to this agent's pipeline access on any pipeline. */
  lastChange: PipelineAccessLastChange | null;
  /** Latest change that touched the grant on each pipeline. Every listed pipeline has an entry. */
  lastChanges: Record<string, PipelineAccessLastChange | null>;
}

/** Agent × pipeline access overview (GRE-1073). */
export interface PipelineAccessMatrix {
  pipelines: Array<{ id: string; name: string; archivedAt: string | null }>;
  agents: PipelineAccessMatrixAgent[];
  /** True when the viewer may change grants (board user with users:manage_permissions). */
  canManage: boolean;
  /** True when the viewer may create pipelines (pipelines:write for the company). */
  canCreatePipelines: boolean;
  /** Pipelines the viewer may administer: rename, archive, edit stages and moves. */
  administerPipelineIds: string[];
}

function levelOnPipeline(access: unknown, pipelineId: string): PipelineAccessLevel | undefined {
  if (!access || typeof access !== "object") return undefined;
  const { level, pipelineIds } = access as { level?: unknown; pipelineIds?: unknown };
  if (!PIPELINE_ACCESS_LEVELS.includes(level as PipelineAccessLevel)) return undefined;
  if (level === "view") return "view";
  if (pipelineIds === null || pipelineIds === undefined) return level as PipelineAccessLevel;
  if (!Array.isArray(pipelineIds)) return undefined;
  return pipelineIds.includes(pipelineId) ? (level as PipelineAccessLevel) : "view";
}

/**
 * The pipelines one `agent.pipeline_access_updated` entry touched (GRE-1073).
 * A per-pipeline change names its pipeline. An all-pipelines change lists
 * `changedPipelineIds`; older entries (GRE-1072) record the access before and
 * after, and touched the pipelines whose level differs. Details that cannot
 * be read count as touching every pipeline.
 */
export function pipelinesTouchedByAccessChange(
  details: Record<string, unknown> | null | undefined,
  pipelineIds: ReadonlyArray<string>,
): string[] {
  if (details && typeof details.pipelineId === "string") {
    return pipelineIds.includes(details.pipelineId) ? [details.pipelineId] : [];
  }
  if (details && Array.isArray(details.changedPipelineIds)) {
    const changed = details.changedPipelineIds;
    return pipelineIds.filter((pipelineId) => changed.includes(pipelineId));
  }
  return pipelineIds.filter((pipelineId) => {
    const before = levelOnPipeline(details?.before, pipelineId);
    const after = levelOnPipeline(details?.after, pipelineId);
    return before === undefined || after === undefined || before !== after;
  });
}

/**
 * Level for every pipeline when the agent holds one "all pipelines" grant
 * (or none), else null.
 */
export function pipelineAllPipelinesLevel(grants: ReadonlyArray<PipelineGrantLike>): PipelineAccessLevel | null {
  const admin = grants.find((grant) => grant.permissionKey === PIPELINE_ADMIN_PERMISSION_KEY);
  const cases = grants.find((grant) => grant.permissionKey === PIPELINE_CASES_PERMISSION_KEY);
  if (admin) return pipelineAccessScopeIds(admin.scope) === null ? "administer" : null;
  if (cases) return pipelineAccessScopeIds(cases.scope) === null ? "work_cases" : null;
  return "view";
}
