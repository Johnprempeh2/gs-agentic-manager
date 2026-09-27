import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueComments,
  issues,
  projects,
} from "@greatstone/db";
import { renderPaperclipWakePrompt } from "@greatstone/adapter-utils/server-utils";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { buildExecutionContinuation } from "./execution-continuation.js";

// GRE-36: the new assignee's wake carries the old run's last progress.
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("reassignment handover payload", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), projectId = randomUUID(), workspaceId = randomUUID();
  const oldAgentId = randomUUID(), newAgentId = randomUUID(), issueId = randomUUID();
  const oldRunId = randomUUID(), lastCommentId = randomUUID();
  const listed: Array<{ cwd: string; baseRef: string | null }> = [];
  const listChangedFiles = async (input: { cwd: string; baseRef: string | null }) => {
    listed.push(input);
    return ["server/src/fix.ts", "server/src/fix.test.ts"];
  };

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-reassignment-handover-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Handover", issuePrefix: "HND" });
    await db.insert(agents).values([
      { id: oldAgentId, companyId, name: "Builder", role: "engineer", adapterType: "acpx_claude" },
      { id: newAgentId, companyId, name: "Reviewer", role: "qa", adapterType: "acpx_claude" },
    ]);
    await db.insert(projects).values({ id: projectId, companyId, name: "Platform" });
    await db.insert(executionWorkspaces).values({
      id: workspaceId, companyId, projectId, mode: "isolated_workspace", strategyType: "git_worktree",
      name: "HND-1", cwd: "/tmp/hnd-1", baseRef: "main", branchName: "HND-1-fix", providerType: "local_fs",
    });
    await db.insert(issues).values({
      id: issueId, companyId, projectId, title: "Fix the strand", status: "in_review",
      assigneeAgentId: newAgentId, executionWorkspaceId: workspaceId,
    });
    await db.insert(heartbeatRuns).values({
      id: oldRunId, companyId, agentId: oldAgentId, status: "succeeded",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      resultJson: { summary: "PR #12 is open. Tests pass. Setting the reviewer next." },
    });
    await db.insert(issueComments).values([
      { companyId, issueId, authorType: "agent", authorAgentId: oldAgentId, body: "Started.",
        createdAt: new Date("2026-09-27T10:00:00Z") },
      { id: lastCommentId, companyId, issueId, authorType: "agent", authorAgentId: oldAgentId,
        body: "PR #12 opened; ran server tests, 8 passed.", createdAt: new Date("2026-09-27T10:05:00Z") },
    ]);
  }, 60_000);
  afterAll(async () => {
    await database?.cleanup();
  });

  it("gives the new assignee the old run's summary, last comment, and changed files", async () => {
    const envelope = await buildExecutionContinuation({
      db, companyId, issueId, agentId: newAgentId,
      context: { issueId, wakeReason: "execution_review_requested", handoffFromRunId: oldRunId },
      summary: null, exposeLowTrustRaw: false, listChangedFiles,
    });
    expect(envelope.handover).toEqual({
      fromRunId: oldRunId,
      fromAgentId: oldAgentId,
      runStatus: "succeeded",
      runSummary: "PR #12 is open. Tests pass. Setting the reviewer next.",
      lastComment: expect.objectContaining({ id: lastCommentId, body: "PR #12 opened; ran server tests, 8 passed." }),
      branchName: "HND-1-fix",
      changedFiles: ["server/src/fix.ts", "server/src/fix.test.ts"],
    });
    expect(listed).toContainEqual({ cwd: "/tmp/hnd-1", baseRef: "main" });
    // A self-handoff is not an interruption.
    expect(envelope.interruptedRunId).toBeUndefined();

    const prompt = renderPaperclipWakePrompt({ executionContinuation: envelope }, { resumedSession: false });
    const [request, evidence] = prompt.split("### Untrusted continuation evidence");
    expect(request).toContain("handed over from another agent's run");
    // Handover text is agent-authored: evidence only, never request context.
    expect(request).not.toContain("handover");
    expect(evidence).toContain("handover");
    expect(evidence).toContain("server/src/fix.ts");
    expect(evidence).toContain("Setting the reviewer next.");
  });

  it("uses an interrupted run from another agent as the handover source too", async () => {
    const envelope = await buildExecutionContinuation({
      db, companyId, issueId, agentId: newAgentId,
      context: { issueId, wakeReason: "issue_assigned", interruptedRunId: oldRunId },
      summary: null, exposeLowTrustRaw: false, listChangedFiles,
    });
    expect(envelope.handover?.fromRunId).toBe(oldRunId);
    expect(envelope.interruptedRunId).toBe(oldRunId);
  });

  it("adds no handover when the source run is the same agent or another task", async () => {
    const otherIssueRun = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: otherIssueRun, companyId, agentId: oldAgentId, status: "succeeded",
      contextSnapshot: { issueId: randomUUID() },
    });
    const none = await buildExecutionContinuation({
      db, companyId, issueId, agentId: newAgentId,
      context: { issueId, wakeReason: "issue_assigned", handoffFromRunId: otherIssueRun },
      summary: null, exposeLowTrustRaw: false, listChangedFiles,
    });
    expect(none.handover).toBeUndefined();
    const ownRun = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: ownRun, companyId, agentId: newAgentId, status: "succeeded", contextSnapshot: { issueId },
    });
    const own = await buildExecutionContinuation({
      db, companyId, issueId, agentId: newAgentId,
      context: { issueId, wakeReason: "issue_assigned", handoffFromRunId: ownRun },
      summary: null, exposeLowTrustRaw: false, listChangedFiles,
    });
    expect(own.handover).toBeUndefined();
  });
});
