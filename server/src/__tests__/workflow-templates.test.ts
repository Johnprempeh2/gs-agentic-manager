import request from "supertest";
import { eq, inArray, isNotNull } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  documentRevisions,
  documents,
  issueDocuments,
  issueRelations,
  issues,
  workflowTemplates,
} from "@greatstone/db";
import {
  RESEARCH_PACK_WORKFLOW_TEMPLATE_PRESET,
  type WorkflowTemplate,
  type WorkflowTemplateDefinition,
  type WorkflowTemplateStartResult,
} from "@greatstone/shared";
import { expect, it, vi } from "vitest";
import { workflowTemplateRoutes } from "../routes/workflow-templates.js";
import { workflowTemplateService } from "../services/workflow-templates.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
  type BoardActor,
} from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("workflow templates: research pack (GRE-1145)", () => {
  const ctx = useEmbeddedPostgres("gsam-workflow-templates-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(issueRelations);
      await db.delete(issueDocuments);
      await db.delete(documentRevisions);
      await db.delete(documents);
      await db.delete(workflowTemplates);
      await db.delete(issues).where(isNotNull(issues.parentId));
      await db.delete(issues);
      await db.delete(agents);
      await resetCompanyIssueFixtures(db);
    },
  });

  const wakeup = vi.fn(async () => undefined);
  function app(actor: BoardActor) {
    wakeup.mockClear();
    return routeApp(ctx.db, actor, (db) => workflowTemplateRoutes(db, { heartbeat: { wakeup } }));
  }

  async function seedAgent(companyId: string, name: string, status = "idle") {
    const [agent] = await ctx.db
      .insert(agents)
      .values({ companyId, name, role: "engineer", status, adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} })
      .returning();
    return agent;
  }

  /** The preset with agents on the coordinator and every step. */
  function presetWithAgents(coordinatorId: string, stepAgentId: string, overrides: Record<string, string> = {}) {
    const definition = structuredClone(RESEARCH_PACK_WORKFLOW_TEMPLATE_PRESET.definition);
    definition.coordinator.assigneeAgentId = coordinatorId;
    for (const step of definition.steps) step.assigneeAgentId = overrides[step.key] ?? stepAgentId;
    return definition;
  }

  async function createTemplate(actor: BoardActor, companyId: string, definition: WorkflowTemplateDefinition) {
    const res = await request(app(actor))
      .post(`/api/companies/${companyId}/workflow-templates`)
      .send({ key: RESEARCH_PACK_WORKFLOW_TEMPLATE_PRESET.key, name: RESEARCH_PACK_WORKFLOW_TEMPLATE_PRESET.name, definition });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as WorkflowTemplate;
  }

  async function slotsFor(issueIds: string[]) {
    return ctx.db
      .select({ issueId: issueDocuments.issueId, key: issueDocuments.key, body: documents.latestBody, title: documents.title })
      .from(issueDocuments)
      .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
      .where(inArray(issueDocuments.issueId, issueIds));
  }

  it("creates the coordinator, step issues with assignees and blockers, and empty document slots", async () => {
    const { companyId, actor, userId } = await seedCompanyWithBoardAccess(ctx.db, "Pack");
    const coordinator = await seedAgent(companyId, "Coordinator");
    const researcher = await seedAgent(companyId, "Researcher");
    const template = await createTemplate(actor, companyId, presetWithAgents(coordinator.id, researcher.id, { intake: coordinator.id }));

    const res = await request(app(actor)).post(`/api/workflow-templates/${template.id}/start`).send({ title: "Test pack" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const result = res.body as WorkflowTemplateStartResult;

    const [parent] = await ctx.db.select().from(issues).where(eq(issues.id, result.coordinator.id));
    expect(parent).toMatchObject({ companyId, title: "Test pack", assigneeAgentId: coordinator.id, status: "todo", parentId: null });
    expect(parent.description).toContain('Started from the workflow template "Research pack"');

    const children = await ctx.db.select().from(issues).where(eq(issues.parentId, parent.id));
    expect(children).toHaveLength(8);
    expect(result.steps.map((step) => [step.stepKey, step.title, step.status, step.assigneeAgentId])).toEqual([
      ["intake", "Test pack: Intake", "todo", coordinator.id],
      ["records", "Test pack: Read client records and open the evidence table", "blocked", researcher.id],
      ["analogues", "Test pack: Search past engagements", "blocked", researcher.id],
      ["environment", "Test pack: Environment scan", "blocked", researcher.id],
      ["benchmarks", "Test pack: Global benchmarks", "blocked", researcher.id],
      ["synthesis", "Test pack: Synthesis", "blocked", researcher.id],
      ["check", "Test pack: Check", "blocked", researcher.id],
      ["deck", "Test pack: Build the deck", "blocked", researcher.id],
    ]);

    // Blockers are real issue relations, so the normal unblock path wakes each step.
    const idByKey = new Map(result.steps.map((step) => [step.stepKey, step.id]));
    const relations = await ctx.db.select().from(issueRelations).where(eq(issueRelations.companyId, companyId));
    const blockersOf = (key: string) =>
      relations.filter((r) => r.type === "blocks" && r.relatedIssueId === idByKey.get(key)).map((r) => r.issueId).sort();
    expect(blockersOf("records")).toEqual([idByKey.get("intake")]);
    expect(blockersOf("synthesis")).toEqual(
      ["records", "analogues", "environment", "benchmarks"].map((key) => idByKey.get(key)).sort(),
    );
    expect(blockersOf("deck")).toEqual([idByKey.get("check")]);

    const slots = await slotsFor(result.steps.map((step) => step.id));
    expect(slots.map((slot) => slot.key).sort()).toEqual(
      ["analogues", "benchmarks", "check-report", "environment", "evidence", "fact-sheet", "intake", "pre-read"],
    );
    expect(slots.every((slot) => slot.body === "")).toBe(true);
    expect(slots.find((slot) => slot.key === "fact-sheet")?.issueId).toBe(idByKey.get("records"));

    // Only work that can start now wakes: the coordinator and the intake step.
    const woken = (wakeup.mock.calls as unknown as Array<[string, { payload: { issueId: string } }]>).map(
      ([, opts]) => opts.payload.issueId,
    );
    expect(woken.sort()).toEqual([parent.id, idByKey.get("intake")].sort());
    expect(userId).toBeTruthy();
  });

  it("puts R1-R3 on the right steps, in order, with the chosen reviewer", async () => {
    const { companyId, actor, userId } = await seedCompanyWithBoardAccess(ctx.db, "Stages");
    const definition = structuredClone(RESEARCH_PACK_WORKFLOW_TEMPLATE_PRESET.definition);
    // Two reviews on one step keep the template order.
    definition.reviews.splice(2, 0, { key: "r2b", label: "R2b Legal look", stepKey: "check", type: "review", participants: [] });
    const template = await createTemplate(actor, companyId, definition);

    const res = await request(app(actor)).post(`/api/workflow-templates/${template.id}/start`).send({ title: "Stage pack" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const result = res.body as WorkflowTemplateStartResult;

    const withReviews = result.steps.filter((step) => step.reviewKeys.length > 0);
    expect(withReviews.map((step) => [step.stepKey, step.reviewKeys])).toEqual([
      ["intake", ["r1"]],
      ["check", ["r2", "r2b"]],
      ["deck", ["r3"]],
    ]);
    const rows = await ctx.db.select().from(issues).where(inArray(issues.id, withReviews.map((step) => step.id)));
    const policyOf = (key: string) => {
      const row = rows.find((candidate) => candidate.id === withReviews.find((step) => step.stepKey === key)!.id)!;
      return row.executionPolicy as { stages: Array<{ type: string; participants: Array<{ type: string; userId: string }> }> };
    };
    expect(policyOf("intake").stages.map((stage) => stage.type)).toEqual(["approval"]);
    expect(policyOf("check").stages.map((stage) => stage.type)).toEqual(["approval", "review"]);
    expect(policyOf("deck").stages.map((stage) => stage.type)).toEqual(["approval"]);
    expect(policyOf("intake").stages[0].participants).toMatchObject([{ type: "user", userId }]);

    // Steps without a review carry no stages.
    const plain = await ctx.db.select().from(issues).where(eq(issues.id, result.steps.find((s) => s.stepKey === "synthesis")!.id));
    expect(plain[0].executionPolicy).toBeNull();
  });

  it("rolls the whole pack back when a step fails inside the transaction", async () => {
    const { companyId, actor, userId } = await seedCompanyWithBoardAccess(ctx.db, "Rollback");
    const coordinator = await seedAgent(companyId, "Coordinator");
    const researcher = await seedAgent(companyId, "Researcher");
    const template = await createTemplate(actor, companyId, presetWithAgents(coordinator.id, researcher.id));
    // The fourth step's assignee stops taking work after the template was saved. The service
    // writes the coordinator, three steps and their slots, then fails on step four.
    const gone = await seedAgent(companyId, "Gone", "terminated");
    const definition = structuredClone(template.definition);
    definition.steps.find((step) => step.key === "environment")!.assigneeAgentId = gone.id;
    const [before] = await ctx.db.select({ counter: companies.issueCounter }).from(companies).where(eq(companies.id, companyId));

    await expect(
      workflowTemplateService(ctx.db).start({ ...template, definition }, { title: "Broken pack" }, { agentId: null, userId, runId: null }),
    ).rejects.toThrow("Cannot assign work to terminated agents");

    expect(await ctx.db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(0);
    expect(await ctx.db.select().from(documents).where(eq(documents.companyId, companyId))).toHaveLength(0);
    expect(await ctx.db.select().from(issueRelations).where(eq(issueRelations.companyId, companyId))).toHaveLength(0);
    const [after] = await ctx.db.select({ counter: companies.issueCounter }).from(companies).where(eq(companies.id, companyId));
    expect(after.counter).toBe(before.counter);
  });

  it("refuses an assignee who cannot take work before writing anything", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Gate");
    const coordinator = await seedAgent(companyId, "Coordinator");
    const gone = await seedAgent(companyId, "Gone", "terminated");
    const template = await createTemplate(actor, companyId, presetWithAgents(coordinator.id, coordinator.id, { environment: gone.id }));

    const res = await request(app(actor)).post(`/api/workflow-templates/${template.id}/start`).send({ title: "Broken pack" });
    expect(res.status).toBe(403);
    expect(await ctx.db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(0);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("refuses a review with no reviewer before writing anything", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "NoReviewer");
    const researcher = await seedAgent(companyId, "Researcher");
    const template = await createTemplate(actor, companyId, presetWithAgents(researcher.id, researcher.id));
    const agentActor = { type: "agent", agentId: researcher.id, companyId, runId: null, source: "agent_key" } as never;

    const res = await request(app(agentActor)).post(`/api/workflow-templates/${template.id}/start`).send({ title: "Pack" });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("has no reviewer");
    expect(await ctx.db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(0);
  });

  it("keeps templates as checked company data", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Data");
    const other = await seedCompanyWithBoardAccess(ctx.db, "Other");
    const outsider = await seedAgent(other.companyId, "Outsider");

    // A step can only wait for an earlier step.
    const backwards = structuredClone(RESEARCH_PACK_WORKFLOW_TEMPLATE_PRESET.definition);
    backwards.steps[0].blockedBy = ["deck"];
    const badOrder = await request(app(actor))
      .post(`/api/companies/${companyId}/workflow-templates`)
      .send({ key: "bad", name: "Bad", definition: backwards });
    expect(badOrder.status).toBe(400);

    // Agents from another company cannot be named.
    const foreign = structuredClone(RESEARCH_PACK_WORKFLOW_TEMPLATE_PRESET.definition);
    foreign.steps[1].assigneeAgentId = outsider.id;
    const badAgent = await request(app(actor))
      .post(`/api/companies/${companyId}/workflow-templates`)
      .send({ key: "foreign", name: "Foreign", definition: foreign });
    expect(badAgent.status).toBe(422);

    const template = await createTemplate(actor, companyId, RESEARCH_PACK_WORKFLOW_TEMPLATE_PRESET.definition);
    const renamed = structuredClone(template.definition);
    renamed.steps[0].title = "Scope intake";
    const patch = await request(app(actor)).patch(`/api/workflow-templates/${template.id}`).send({ definition: renamed });
    expect(patch.status).toBe(200);
    expect((patch.body as WorkflowTemplate).definition.steps[0].title).toBe("Scope intake");

    // Another company cannot see or start it.
    const otherRead = await request(app(other.actor)).get(`/api/workflow-templates/${template.id}`);
    expect(otherRead.status).toBe(404);
    const otherStart = await request(app(other.actor)).post(`/api/workflow-templates/${template.id}/start`).send({ title: "Steal" });
    expect(otherStart.status).toBe(404);
    expect(await ctx.db.select().from(issues).where(eq(issues.companyId, other.companyId))).toHaveLength(0);
    const otherList = await request(app(other.actor)).get(`/api/companies/${other.companyId}/workflow-templates`);
    expect(otherList.body).toEqual([]);

    // Agents may not edit templates.
    const agent = await seedAgent(companyId, "Agent");
    const agentActor = { type: "agent", agentId: agent.id, companyId, runId: null, source: "agent_key" } as never;
    const agentPatch = await request(app(agentActor)).patch(`/api/workflow-templates/${template.id}`).send({ name: "Mine" });
    expect(agentPatch.status).toBe(403);

    // Archived templates leave the list and cannot start.
    await request(app(actor)).patch(`/api/workflow-templates/${template.id}`).send({ archived: true });
    expect((await request(app(actor)).get(`/api/companies/${companyId}/workflow-templates`)).body).toEqual([]);
    const archivedStart = await request(app(actor)).post(`/api/workflow-templates/${template.id}/start`).send({ title: "Late" });
    expect(archivedStart.status).toBe(422);
  });
});
