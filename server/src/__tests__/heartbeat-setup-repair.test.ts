import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  projects,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { getHeartbeatRunRuntimeStatus } from "../services/heartbeat-run-runtime-status.js";

// GRE-395: a run that fails on a known setup cause is repaired by the app and
// the agent gets exactly one wake with a plain comment. An unsafe repair, or
// the same cause twice in 30 minutes, ends `blocked` with the board as owner.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const GB = 1024 * 1024 * 1024;
const TASK_BRANCH = "GRE-1-task";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

describeEmbeddedPostgres("heartbeat setup repair (GRE-395)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-setup-repair-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 30_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(heartbeatRunEvents);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
    while (tempDirs.length > 0) {
      await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function makeTaskWorktree() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "heartbeat-setup-repair-"));
    tempDirs.push(root);
    const origin = path.join(root, "origin.git");
    const repo = path.join(root, "repo");
    git(root, "init", "--bare", "-b", "main", origin);
    git(root, "clone", origin, repo);
    git(repo, "config", "user.email", "ridge@example.com");
    git(repo, "config", "user.name", "Ridge");
    await fs.writeFile(path.join(repo, "a.txt"), "a\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-m", "base");
    git(repo, "push", "origin", "main");
    const worktree = path.join(root, TASK_BRANCH);
    git(repo, "worktree", "add", "-b", TASK_BRANCH, worktree, "main");
    return worktree;
  }

  async function seed(input: {
    errorCode: string;
    error?: string;
    resultJson?: (ids: { executionWorkspaceId: string }) => Record<string, unknown>;
    workspaceCwd: string;
    retryOfRunId?: boolean;
    now: Date;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Greatstone",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Builder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Platform", status: "in_progress" });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Setup repair fixture",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      sourceIssueId: issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: TASK_BRANCH,
      status: "active",
      cwd: input.workspaceCwd,
      baseRef: "origin/main",
      branchName: TASK_BRANCH,
      providerType: "git_worktree",
      providerRef: input.workspaceCwd,
    });
    let previousRunId: string | null = null;
    if (input.retryOfRunId) {
      previousRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: previousRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "failed",
        errorCode: input.errorCode,
        finishedAt: input.now,
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
        createdAt: new Date(input.now.getTime() - 60_000),
        updatedAt: input.now,
      });
    }
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "failed",
      error: input.error ?? "setup failed",
      errorCode: input.errorCode,
      finishedAt: input.now,
      retryOfRunId: previousRunId,
      resultJson: {
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        ...(input.resultJson?.({ executionWorkspaceId }) ?? {}),
      },
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      createdAt: input.now,
      updatedAt: input.now,
    });
    await db
      .update(issues)
      .set({ executionRunId: runId, executionWorkspaceId, executionWorkspacePreference: "reuse_existing" })
      .where(eq(issues.id, issueId));
    return { companyId, agentId, issueId, executionWorkspaceId, runId };
  }

  async function wakesFor(issueId: string) {
    const runs = await db.select().from(heartbeatRuns);
    return runs.filter(
      (run) =>
        (run.contextSnapshot as Record<string, unknown> | null)?.issueId === issueId &&
        ["scheduled_retry", "queued", "running"].includes(run.status),
    );
  }

  async function commentsFor(issueId: string) {
    return db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
  }

  it("workspace_validation_failed: puts the worktree back on the task branch and wakes once", async () => {
    const now = new Date();
    const worktree = await makeTaskWorktree();
    git(worktree, "switch", "-c", "stray");
    const fixture = await seed({
      errorCode: "workspace_validation_failed",
      error: "Execution workspace expected git worktree branch",
      workspaceCwd: worktree,
      resultJson: ({ executionWorkspaceId }) => ({
        workspaceValidation: {
          reason: "git_worktree_branch_incoherence",
          persistedExecutionWorkspaceId: executionWorkspaceId,
          managedGitWorktreeBranch: { worktreePath: worktree, expectedBranchName: TASK_BRANCH, actualBranchName: "stray" },
        },
      }),
      now,
    });

    const first = await heartbeat.repairAndResumeSetupFailure(fixture.runId, { now });
    expect(first).toMatchObject({ outcome: "resumed", cause: "workspace_mismatch" });
    expect(git(worktree, "symbolic-ref", "--short", "HEAD")).toBe(TASK_BRANCH);

    // At-least-once: a repeated call reuses the same wake and posts nothing new.
    await heartbeat.repairAndResumeSetupFailure(fixture.runId, { now });

    const wakes = await wakesFor(fixture.issueId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      status: "scheduled_retry",
      retryOfRunId: fixture.runId,
      scheduledRetryReason: "setup_repair",
    });
    const comments = await commentsFor(fixture.issueId);
    expect(comments.map((c) => c.body)).toEqual([
      "Your run stopped because its workspace was on the wrong branch or path. The app fixed it (put the workspace back on the task branch). Please carry on.",
    ]);
    const [issue] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect(issue?.status).toBe("in_progress");
  });

  it("setup_failed on workspace reuse: archives the broken workspace so the retry gets a fresh one", async () => {
    const now = new Date();
    const missingCwd = path.join(os.tmpdir(), `gre-395-missing-${randomUUID()}`);
    const fixture = await seed({
      errorCode: "setup_failed",
      error: "Issue GRE-1 requested inherited execution workspace reuse for ws, but the workspace could not be restored because install failed.",
      workspaceCwd: missingCwd,
      resultJson: ({ executionWorkspaceId }) => ({ workspaceReuseFailure: { executionWorkspaceId } }),
      now,
    });

    expect(await heartbeat.repairAndResumeSetupFailure(fixture.runId, { now })).toMatchObject({
      outcome: "resumed",
      cause: "workspace_reuse_failed",
    });

    expect(await wakesFor(fixture.issueId)).toHaveLength(1);
    const [workspace] = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, fixture.executionWorkspaceId));
    expect(workspace?.status).toBe("archived");
    const [issue] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect(issue).toMatchObject({ status: "in_progress", executionWorkspaceId: null, executionWorkspacePreference: null });
    expect((await commentsFor(fixture.issueId)).map((c) => c.body)).toEqual([
      "Your run stopped because its saved workspace could not be reused. The app fixed it (gave the task a fresh workspace from its own branch). Please carry on.",
    ]);
  });

  it("process_lost after its retry: does not retry again and blocks with the board as owner", async () => {
    const now = new Date();
    const fixture = await seed({
      errorCode: "process_lost",
      error: "Process lost",
      workspaceCwd: "/nonexistent",
      retryOfRunId: true,
      now,
    });

    expect(await heartbeat.repairAndResumeSetupFailure(fixture.runId, { now })).toMatchObject({
      outcome: "blocked",
      cause: "process_lost",
    });

    expect(await wakesFor(fixture.issueId)).toHaveLength(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect(issue?.status).toBe("blocked");
    expect(issue?.unblockDescriptor).toMatchObject({ owner: "board" });
    const [comment] = await commentsFor(fixture.issueId);
    expect(comment?.body).toMatch(/^Your run stopped because its process was lost\. The app did not retry: the retry was lost too\. The board must act: /);
  });

  it("process_lost through the reaper: a lost retry with its budget spent ends blocked, not retried", async () => {
    const now = new Date();
    const fixture = await seed({
      errorCode: "process_lost",
      workspaceCwd: "/nonexistent",
      retryOfRunId: true,
      now,
    });
    // The run is the last allowed retry, still marked running with a dead pid.
    await db
      .update(heartbeatRuns)
      .set({
        status: "running",
        error: null,
        errorCode: null,
        finishedAt: null,
        processPid: 999_999_999,
        startedAt: new Date(now.getTime() - 120_000),
        updatedAt: new Date(now.getTime() - 120_000),
        scheduledRetryAttempt: 2,
        scheduledRetryReason: "transient_failure",
        resultJson: { conversationContinuation: "continue_conversation_v1" },
        contextSnapshot: {
          issueId: fixture.issueId,
          wakeReason: "transient_failure_retry",
          executionRetryAccounting: { version: 1, failureRetries: 2, maxTurnContinuations: 0 },
        },
      })
      .where(eq(heartbeatRuns.id, fixture.runId));
    await db
      .update(agents)
      .set({ adapterType: "claude_local", status: "running" })
      .where(eq(agents.id, fixture.agentId));

    const reap = await heartbeat.reapOrphanedRuns();
    expect(reap.runIds).toEqual([fixture.runId]);

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect(run).toMatchObject({ status: "failed", errorCode: "process_lost" });
    expect(await wakesFor(fixture.issueId)).toHaveLength(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect(issue?.status).toBe("blocked");
    expect(issue?.unblockDescriptor).toMatchObject({ owner: "board" });
    const bodies = (await commentsFor(fixture.issueId)).map((c) => c.body);
    expect(bodies.filter((b) => b.startsWith("Your run stopped because its process was lost."))).toHaveLength(1);
  });

  it("unsafe repair: uncommitted work in the worktree blocks instead of retrying", async () => {
    const now = new Date();
    const worktree = await makeTaskWorktree();
    git(worktree, "switch", "-c", "stray");
    await fs.writeFile(path.join(worktree, "wip.txt"), "wip\n");
    const fixture = await seed({
      errorCode: "workspace_validation_failed",
      workspaceCwd: worktree,
      resultJson: () => ({ workspaceValidation: { worktreePath: worktree, expectedBranchName: TASK_BRANCH } }),
      now,
    });

    expect(await heartbeat.repairAndResumeSetupFailure(fixture.runId, { now })).toMatchObject({ outcome: "blocked" });
    // A repeated call posts nothing new.
    await heartbeat.repairAndResumeSetupFailure(fixture.runId, { now });

    // No retry. The release path then blocks the task through the board
    // escalation (covered end to end in heartbeat-workspace-branch-containment).
    expect(await wakesFor(fixture.issueId)).toHaveLength(0);
    // Nothing was touched: still on the stray branch with the file in place.
    expect(git(worktree, "symbolic-ref", "--short", "HEAD")).toBe("stray");
    await expect(fs.readFile(path.join(worktree, "wip.txt"), "utf8")).resolves.toBe("wip\n");
    const comments = await commentsFor(fixture.issueId);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toMatch(
      /^Your run stopped because its workspace was on the wrong branch or path\. The app did not retry: the workspace has uncommitted changes in .+\. The board must act: /,
    );
  });

  it("the same cause twice in 30 minutes blocks instead of retrying", async () => {
    const now = new Date();
    const worktree = await makeTaskWorktree();
    const fixture = await seed({
      errorCode: "workspace_validation_failed",
      workspaceCwd: worktree,
      resultJson: () => ({ workspaceValidation: { worktreePath: worktree, expectedBranchName: TASK_BRANCH } }),
      now,
    });
    // An earlier repair of the same cause on this task, ten minutes ago.
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      invocationSource: "automation",
      status: "failed",
      errorCode: "workspace_validation_failed",
      scheduledRetryReason: "setup_repair",
      scheduledRetryAttempt: 1,
      contextSnapshot: { issueId: fixture.issueId, setupRepair: { cause: "workspace_mismatch" } },
      createdAt: new Date(now.getTime() - 10 * 60_000),
      updatedAt: now,
    });

    expect(await heartbeat.repairAndResumeSetupFailure(fixture.runId, { now })).toMatchObject({
      outcome: "blocked",
      reason: "the same failure happened twice in 30 minutes",
    });
    expect(await wakesFor(fixture.issueId)).toHaveLength(0);
    expect((await commentsFor(fixture.issueId)).map((c) => c.body)).toEqual([
      "Your run stopped because its workspace was on the wrong branch or path. The app did not retry: the same failure happened twice in 30 minutes. The board must act: check the workspace, save or push any work in it, then set the task back to in progress.",
    ]);
  });

  it("the resume wake still waits behind the RAM guard", async () => {
    const lowMemoryHeartbeat = heartbeatService(db, {
      memoryReader: async () => ({ availableBytes: 0.5 * GB, pressure: "normal" }),
      diskReader: async () => ({ availableBytes: 500 * GB }),
    });
    const now = new Date();
    const worktree = await makeTaskWorktree();
    git(worktree, "switch", "-c", "stray");
    const fixture = await seed({
      errorCode: "workspace_validation_failed",
      workspaceCwd: worktree,
      resultJson: () => ({ workspaceValidation: { worktreePath: worktree, expectedBranchName: TASK_BRANCH } }),
      now,
    });

    const repaired = await lowMemoryHeartbeat.repairAndResumeSetupFailure(fixture.runId, { now });
    expect(repaired).toMatchObject({ outcome: "resumed" });
    if (repaired.outcome !== "resumed") throw new Error("expected a resume wake");
    await lowMemoryHeartbeat.promoteDueScheduledRetries(new Date(now.getTime() + 1_000));
    expect(await lowMemoryHeartbeat.startNextQueuedRunForAgent(fixture.agentId)).toEqual([]);
    const [wake] = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.retryOfRunId, fixture.runId), eq(heartbeatRuns.companyId, fixture.companyId)));
    expect(wake?.status).toBe("queued");
    expect(getHeartbeatRunRuntimeStatus(repaired.retryRunId)?.message).toMatch(/^Waiting: low memory/);
  });
});
