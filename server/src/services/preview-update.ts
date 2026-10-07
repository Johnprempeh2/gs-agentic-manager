/**
 * Live preview "Update now" and auto-update (GRE-1004).
 *
 * A project workspace that serves a preview can carry an update job (for example
 * "git checkout main && git pull --ff-only && npm install"). Updating runs that job and
 * restarts the preview. A ticker checks workspaces with a running preview every few
 * minutes and updates them when the default branch on `origin` has new commits.
 *
 * The checkout is never touched when it has uncommitted changes or is on another
 * branch; the update is skipped and the reason is shown on the card.
 */
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { projectWorkspaces, workspaceRuntimeServices, type Db } from "@greatstone/db";
import {
  findPreviewUpdateJob,
  PREVIEW_UPDATE_METADATA_KEY,
  readProjectWorkspacePreviewUpdate,
  type Project,
  type ProjectWorkspace,
  type ProjectWorkspacePreviewUpdateState,
  type ProjectWorkspacePreviewUpdateTrigger,
  type WorkspaceCommandDefinition,
} from "@greatstone/shared";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { findExistingManagedProjectCheckout } from "./managed-project-checkout.js";
import { projectService } from "./projects.js";
import { workspaceOperationService } from "./workspace-operations.js";
import {
  runWorkspaceJobForControl,
  startRuntimeServicesForWorkspaceControl,
  stopRuntimeServicesForProjectWorkspace,
} from "./workspace-runtime.js";

const execFile = promisify(execFileCallback);

export { findPreviewUpdateJob };

export const PREVIEW_AUTO_UPDATE_TICK_MS = 3 * 60 * 1000;
const GIT_TIMEOUT_MS = 30_000;
const MESSAGE_MAX_CHARS = 500;

async function git(cwd: string, args: string[]) {
  const result = await execFile("git", ["-C", cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return result.stdout.trim();
}

async function gitOk(cwd: string, args: string[]) {
  return git(cwd, args).then(() => true, () => false);
}

export type PreviewCheckoutInspection =
  | { kind: "skip"; message: string }
  | { kind: "up_to_date"; head: string }
  | { kind: "behind"; head: string; remote: string };

/**
 * Says whether the checkout can be updated and whether `origin` has new commits.
 * Uses `git ls-remote`, so nothing in the checkout changes.
 */
export async function inspectPreviewCheckout(cwd: string, branch: string): Promise<PreviewCheckoutInspection> {
  const current = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current !== branch) {
    return {
      kind: "skip",
      message: `Not updated: the checkout is on ${current === "HEAD" ? "a detached commit" : `"${current}"`}, not "${branch}". Switch it back to ${branch} to update.`,
    };
  }
  const dirty = (await git(cwd, ["status", "--porcelain", "--untracked-files=no"])).split("\n").filter(Boolean);
  if (dirty.length > 0) {
    return {
      kind: "skip",
      message: `Not updated: the checkout has uncommitted changes in ${dirty.length} file${dirty.length === 1 ? "" : "s"}. Commit or discard them, then update.`,
    };
  }
  const head = await git(cwd, ["rev-parse", "HEAD"]);
  const remoteLine = await git(cwd, ["ls-remote", "origin", `refs/heads/${branch}`]);
  const remote = remoteLine.split(/\s+/)[0] ?? "";
  if (!remote) throw new Error(`origin has no "${branch}" branch`);
  if (remote === head) return { kind: "up_to_date", head };
  // The checkout may hold local commits on top of origin; that is not "behind".
  if (await gitOk(cwd, ["merge-base", "--is-ancestor", remote, head])) return { kind: "up_to_date", head };
  return { kind: "behind", head, remote };
}

function clip(message: string) {
  const trimmed = message.trim();
  return trimmed.length > MESSAGE_MAX_CHARS ? `${trimmed.slice(0, MESSAGE_MAX_CHARS - 1)}…` : trimmed;
}

type StatePatch = Partial<Omit<ProjectWorkspacePreviewUpdateState, "autoUpdate">> & { autoUpdate?: boolean };

export interface PreviewUpdateTarget {
  project: Pick<Project, "id" | "companyId" | "codebase">;
  workspace: Pick<ProjectWorkspace, "id" | "cwd" | "repoUrl" | "repoRef" | "defaultRef" | "metadata" | "runtimeConfig" | "runtimeServices">;
}

export interface PreviewUpdateDeps {
  loadTarget(projectId: string, workspaceId: string): Promise<PreviewUpdateTarget | null>;
  /** Workspaces whose preview is running right now. */
  listRunningPreviewWorkspaces(): Promise<Array<{ projectId: string; workspaceId: string }>>;
  saveState(workspaceId: string, patch: StatePatch): Promise<void>;
  resolveCwd(target: PreviewUpdateTarget): Promise<string | null>;
  inspect(cwd: string, branch: string): Promise<PreviewCheckoutInspection>;
  runJob(target: PreviewUpdateTarget, cwd: string, job: WorkspaceCommandDefinition, trigger: ProjectWorkspacePreviewUpdateTrigger): Promise<void>;
  restart(target: PreviewUpdateTarget, cwd: string): Promise<void>;
  shortHead(cwd: string): Promise<string | null>;
  recordActivity(target: PreviewUpdateTarget, details: Record<string, unknown>, actor: PreviewUpdateActor | null): Promise<void>;
  now(): Date;
}

export interface PreviewUpdateActor {
  actorType: "user" | "agent";
  actorId: string;
  agentId: string | null;
}

export type PreviewUpdateOutcome =
  | { kind: "busy" }
  | { kind: "not_found" }
  | { kind: "no_update_job" }
  | { kind: "no_checkout" }
  | { kind: "finished"; state: ProjectWorkspacePreviewUpdateStatus };

type ProjectWorkspacePreviewUpdateStatus = NonNullable<ProjectWorkspacePreviewUpdateState["status"]>;

function previewIsRunning(target: PreviewUpdateTarget) {
  return (target.workspace.runtimeServices ?? []).some((service) =>
    service.status === "running" || service.status === "starting" || service.status === "provisioning");
}

export function createPreviewUpdateService(deps: PreviewUpdateDeps) {
  const inFlight = new Set<string>();

  /**
   * Checks the checkout, runs the update job when origin is ahead, and restarts a running
   * preview. "manual" always records its result; "auto" stays quiet while nothing changes.
   */
  async function update(input: {
    projectId: string;
    workspaceId: string;
    trigger: ProjectWorkspacePreviewUpdateTrigger;
    actor?: PreviewUpdateActor | null;
    /** Called once the update is known to run, before the slow job starts. */
    onStarted?: () => void;
  }): Promise<PreviewUpdateOutcome> {
    if (inFlight.has(input.workspaceId)) return { kind: "busy" };
    inFlight.add(input.workspaceId);
    try {
      const target = await deps.loadTarget(input.projectId, input.workspaceId);
      if (!target) return { kind: "not_found" };
      const job = findPreviewUpdateJob(target.workspace.runtimeConfig?.workspaceRuntime ?? null);
      if (!job) return { kind: "no_update_job" };
      const cwd = await deps.resolveCwd(target);
      if (!cwd) return { kind: "no_checkout" };

      const previous = readProjectWorkspacePreviewUpdate(target.workspace.metadata);
      const branch = target.workspace.defaultRef ?? target.workspace.repoRef ?? "main";
      const checkedAt = () => deps.now().toISOString();
      const finish = async (status: ProjectWorkspacePreviewUpdateStatus, patch: StatePatch) => {
        const quiet = input.trigger === "auto"
          && previous.status === status
          && previous.message === (patch.message ?? null);
        if (!quiet) await deps.saveState(target.workspace.id, { status, trigger: input.trigger, checkedAt: checkedAt(), ...patch });
        return { kind: "finished" as const, state: status };
      };

      if (input.trigger === "manual") {
        await deps.saveState(target.workspace.id, { status: "updating", trigger: "manual", message: null, checkedAt: checkedAt() });
        input.onStarted?.();
      }

      let inspection: PreviewCheckoutInspection;
      try {
        inspection = await deps.inspect(cwd, branch);
      } catch (error) {
        return finish("failed", { message: clip(`Could not check for new commits: ${errorText(error)}`) });
      }
      if (inspection.kind === "skip") {
        if (input.trigger === "auto") logger.info({ workspaceId: target.workspace.id, reason: inspection.message }, "preview auto-update skipped");
        return finish("skipped", { message: inspection.message });
      }
      if (inspection.kind === "up_to_date") {
        return finish("up_to_date", { message: null, commit: previous.commit ?? (await deps.shortHead(cwd)) });
      }

      if (input.trigger === "auto") {
        await deps.saveState(target.workspace.id, { status: "updating", trigger: "auto", message: null, checkedAt: checkedAt() });
      }
      try {
        await deps.runJob(target, cwd, job, input.trigger);
        if (previewIsRunning(target)) await deps.restart(target, cwd);
      } catch (error) {
        const message = clip(`Update failed: ${errorText(error)}`);
        await deps.saveState(target.workspace.id, { status: "failed", trigger: input.trigger, message, checkedAt: checkedAt() });
        await deps.recordActivity(target, { trigger: input.trigger, status: "failed", error: message }, input.actor ?? null);
        return { kind: "finished", state: "failed" };
      }
      const commit = await deps.shortHead(cwd);
      const finishedAt = checkedAt();
      await deps.saveState(target.workspace.id, {
        status: "updated",
        trigger: input.trigger,
        message: null,
        commit,
        updatedAt: finishedAt,
        checkedAt: finishedAt,
      });
      await deps.recordActivity(target, { trigger: input.trigger, status: "updated", commit }, input.actor ?? null);
      return { kind: "finished", state: "updated" };
    } finally {
      inFlight.delete(input.workspaceId);
    }
  }

  /** One auto-update pass over every running preview whose switch is on. */
  async function tick() {
    const candidates = await deps.listRunningPreviewWorkspaces();
    for (const candidate of candidates) {
      const target = await deps.loadTarget(candidate.projectId, candidate.workspaceId).catch(() => null);
      if (!target || !readProjectWorkspacePreviewUpdate(target.workspace.metadata).autoUpdate) continue;
      await update({ ...candidate, trigger: "auto" }).catch((err) =>
        logger.warn({ err, workspaceId: candidate.workspaceId }, "preview auto-update failed"));
    }
  }

  return {
    update,
    tick,
    isUpdating: (workspaceId: string) => inFlight.has(workspaceId),
    setAutoUpdate: (workspaceId: string, enabled: boolean) => deps.saveState(workspaceId, { autoUpdate: enabled }),
  };
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function realizedWorkspace(target: PreviewUpdateTarget, cwd: string) {
  return {
    baseCwd: cwd,
    source: "project_primary" as const,
    projectId: target.project.id,
    workspaceId: target.workspace.id,
    repoUrl: target.workspace.repoUrl,
    repoRef: target.workspace.repoRef,
    strategy: "project_primary" as const,
    cwd,
    branchName: target.workspace.defaultRef ?? target.workspace.repoRef ?? null,
    worktreePath: null,
    warnings: [],
    created: false,
    branchCreatedByRuntime: false,
  };
}

/** Merges into `metadata.previewUpdate` in one statement so it never drops other metadata keys. */
async function savePreviewUpdateState(db: Db, workspaceId: string, patch: StatePatch) {
  await db
    .update(projectWorkspaces)
    .set({
      metadata: sql`coalesce(${projectWorkspaces.metadata}, '{}'::jsonb) || jsonb_build_object(
        ${PREVIEW_UPDATE_METADATA_KEY}::text,
        coalesce(${projectWorkspaces.metadata} -> ${PREVIEW_UPDATE_METADATA_KEY}::text, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
      )`,
    })
    .where(eq(projectWorkspaces.id, workspaceId));
}

function defaultDeps(db: Db): PreviewUpdateDeps {
  const projects = projectService(db);
  const operations = workspaceOperationService(db);
  const systemActor = (target: PreviewUpdateTarget) => ({ id: null, name: "Preview auto-update", companyId: target.project.companyId });
  return {
    async loadTarget(projectId, workspaceId) {
      const project = await projects.getById(projectId);
      const workspace = project?.workspaces.find((entry) => entry.id === workspaceId) ?? null;
      return project && workspace ? { project, workspace } : null;
    },
    async listRunningPreviewWorkspaces() {
      const rows = await db
        .selectDistinct({ projectId: workspaceRuntimeServices.projectId, workspaceId: workspaceRuntimeServices.projectWorkspaceId })
        .from(workspaceRuntimeServices)
        .where(and(
          eq(workspaceRuntimeServices.status, "running"),
          eq(workspaceRuntimeServices.scopeType, "project_workspace"),
          isNotNull(workspaceRuntimeServices.projectWorkspaceId),
          isNotNull(workspaceRuntimeServices.url),
        ));
      return rows.flatMap((row) => (row.projectId && row.workspaceId ? [{ projectId: row.projectId, workspaceId: row.workspaceId }] : []));
    },
    saveState: (workspaceId, patch) => savePreviewUpdateState(db, workspaceId, patch),
    resolveCwd: async (target) => target.workspace.cwd ?? await findExistingManagedProjectCheckout(target.project, target.workspace),
    inspect: inspectPreviewCheckout,
    async runJob(target, cwd, job, trigger) {
      const recorder = operations.createRecorder({ companyId: target.project.companyId });
      await runWorkspaceJobForControl({
        actor: systemActor(target),
        issue: null,
        workspace: realizedWorkspace(target, cwd),
        command: job.rawConfig,
        adapterEnv: {},
        recorder,
        metadata: {
          action: "preview_update",
          trigger,
          projectId: target.project.id,
          projectWorkspaceId: target.workspace.id,
          workspaceCommandId: job.id,
        },
      });
    },
    async restart(target, cwd) {
      const runtimeConfig = target.workspace.runtimeConfig?.workspaceRuntime ?? null;
      if (!runtimeConfig) return;
      await stopRuntimeServicesForProjectWorkspace({ db, projectWorkspaceId: target.workspace.id });
      await startRuntimeServicesForWorkspaceControl({
        db,
        actor: systemActor(target),
        issue: null,
        workspace: realizedWorkspace(target, cwd),
        config: {
          workspaceRuntime: runtimeConfig,
          desiredState: target.workspace.runtimeConfig?.desiredState ?? "running",
          serviceStates: target.workspace.runtimeConfig?.serviceStates ?? null,
        },
        respectDesiredStates: true,
        adapterEnv: {},
        recorder: operations.createRecorder({ companyId: target.project.companyId }),
      });
    },
    shortHead: (cwd) => git(cwd, ["rev-parse", "--short", "HEAD"]).catch(() => null),
    async recordActivity(target, details, actor) {
      await logActivity(db, {
        companyId: target.project.companyId,
        actorType: actor?.actorType ?? "system",
        actorId: actor?.actorId ?? "preview-auto-update",
        agentId: actor?.agentId ?? null,
        action: "project.workspace_preview_update",
        entityType: "project",
        entityId: target.project.id,
        details: { projectWorkspaceId: target.workspace.id, ...details },
      });
    },
    now: () => new Date(),
  };
}

let shared: ReturnType<typeof createPreviewUpdateService> | null = null;

export function previewUpdateService(db: Db) {
  shared ??= createPreviewUpdateService(defaultDeps(db));
  return shared;
}

/** Checks running previews for new commits every few minutes. Returns a stop function. */
export function startPreviewAutoUpdateTicker(db: Db, intervalMs = PREVIEW_AUTO_UPDATE_TICK_MS) {
  const svc = previewUpdateService(db);
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    svc.tick()
      .catch((err) => logger.warn({ err }, "preview auto-update tick failed"))
      .finally(() => { running = false; });
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
