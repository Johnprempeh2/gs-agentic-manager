import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  goals,
  heartbeatRuns,
  instanceSettings,
  issueThreadInteractions,
  issues,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { buildDraftReviewAgentMessage } from "../services/draft-review-wake.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const DRAFT_BODY = "Dear Martyn,\n\nThank you so much for the call today. Here is the enrolment plan.";

describeEmbeddedPostgres("request_draft_review interactions", () => {
  let db!: ReturnType<typeof createDb>;
  let interactionsSvc!: ReturnType<typeof issueThreadInteractionService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-draft-review-");
    db = createDb(tempDb.connectionString);
    interactionsSvc = issueThreadInteractionService(db);
  });

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedDraft() {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "GS Agentic Manager",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    await db.insert(goals).values({ id: goalId, companyId, title: "Drafts", level: "task", status: "active" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Writer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Reply to Indago",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const created = await interactionsSvc.create(
      { id: issueId, companyId },
      {
        kind: "request_draft_review",
        // Even an explicit "anyone" stays human-only for drafts.
        resolverPolicy: "anyone",
        title: "Draft email to Indago",
        payload: {
          version: 1,
          purpose: "Email to Indago",
          body: DRAFT_BODY,
          subject: "Enrolment plan",
          recipients: ["martyn@example.com"],
          channel: "email",
        },
      },
      { agentId },
    );
    return { companyId, goalId, issueId, agentId, created, issue: { id: issueId, companyId, goalId, projectId: null } };
  }

  it("creates a human-only draft card that wakes the assignee by default", async () => {
    const { created, agentId } = await seedDraft();
    expect(created).toMatchObject({
      kind: "request_draft_review",
      status: "pending",
      continuationPolicy: "wake_assignee",
      effectiveResolverPolicy: "human_only",
      createdByAgentId: agentId,
      payload: { purpose: "Email to Indago", body: DRAFT_BODY, supersedeOnUserComment: false },
    });
  });

  it("stores the original, edited text and word diff when a person sends edits", async () => {
    const { created, issue } = await seedDraft();
    const edited = "Hi Martyn,\n\nThanks for the call. Here is the enrolment plan.";
    const { interaction } = await interactionsSvc.acceptInteraction(
      issue,
      created.id,
      { editedBody: edited },
      { userId: "local-board" },
    );
    expect(interaction.status).toBe("accepted");
    const draft = (interaction.result as { draft?: Record<string, unknown> }).draft!;
    expect(draft).toMatchObject({
      originalBody: DRAFT_BODY,
      finalBody: edited,
      edited: true,
      changeCount: 3,
      learnFromEdits: true,
    });
    const message = buildDraftReviewAgentMessage(interaction)!;
    expect(message).toContain("edited \"Email to Indago\"");
    expect(message).toContain(edited);
    expect(message).toContain('removed "Dear", added "Hi"');
    expect(message).toContain("memory_contribute");
  });

  it("approves a draft as is without learning prompts", async () => {
    const { created, issue } = await seedDraft();
    const { interaction } = await interactionsSvc.acceptInteraction(
      issue,
      created.id,
      { learnFromEdits: false },
      { userId: "local-board" },
    );
    const draft = (interaction.result as { draft?: Record<string, unknown> }).draft!;
    expect(draft).toMatchObject({ edited: false, changeCount: 0, finalBody: DRAFT_BODY, learnFromEdits: false });
    expect(buildDraftReviewAgentMessage(interaction)).toContain("approved \"Email to Indago\" as is");
  });

  it("asks for a redraft with a note", async () => {
    const { created, issue } = await seedDraft();
    const interaction = await interactionsSvc.rejectInteraction(
      issue,
      created.id,
      { reason: "Shorter, and mention the June start" },
      { userId: "local-board" },
    );
    expect(interaction).toMatchObject({ status: "rejected", result: { outcome: "rejected", reason: "Shorter, and mention the June start" } });
    const message = buildDraftReviewAgentMessage(interaction)!;
    expect(message).toContain("Shorter, and mention the June start");
    expect(message).toContain("request_draft_review");
  });

  it("does not let the drafting agent resolve its own draft", async () => {
    const { created, issue, agentId, companyId } = await seedDraft();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "running",
      startedAt: new Date(),
    });
    await expect(
      interactionsSvc.acceptInteraction(issue, created.id, {}, { agentId, runId }),
    ).rejects.toMatchObject({ status: 403, message: expect.stringContaining("human-only") });
    await expect(
      interactionsSvc.rejectInteraction(issue, created.id, { reason: "self" }, { agentId, runId }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
