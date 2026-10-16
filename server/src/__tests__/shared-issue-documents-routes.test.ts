import { randomUUID } from "node:crypto";
import request from "supertest";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import {
  activityLog,
  agents,
  documentRevisions,
  documents,
  issueDocumentLinks,
  issueDocuments,
  issues,
} from "@greatstone/db";
import { issueRoutes } from "../routes/issues.js";
import { documentService } from "../services/documents.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

// Shared documents: one live document owned by one task, linked from stage
// tasks, written by the owner's assignee plus one named maker, with one
// revision marked as the approved version.
describeEmbeddedPostgres("shared issue documents", () => {
  const ctx = useEmbeddedPostgres("gsam-shared-docs-", {
    resetEach: async (db) => {
      await db.delete(issueDocumentLinks);
      await db.delete(issueDocuments);
      await db.delete(documentRevisions);
      await db.delete(documents);
      await db.delete(activityLog);
      await db.delete(issues);
      await db.delete(agents);
      await resetCompanyIssueFixtures(db);
    },
  });

  async function insertAgent(companyId: string, name: string) {
    const id = randomUUID();
    await ctx.db.insert(agents).values({
      id,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  async function seed() {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Shared");
    const ownerAgentId = await insertAgent(company.companyId, "Owner");
    const makerAgentId = await insertAgent(company.companyId, "Maker");
    const otherAgentId = await insertAgent(company.companyId, "Other");
    const [ownerIssue] = await ctx.db
      .insert(issues)
      .values({
        companyId: company.companyId,
        title: "Plan the pack",
        identifier: "SHR-1",
        status: "todo",
        assigneeAgentId: ownerAgentId,
      })
      .returning();
    const [stageIssue] = await ctx.db
      .insert(issues)
      .values({
        companyId: company.companyId,
        title: "Review stage",
        identifier: "SHR-2",
        status: "todo",
        assigneeAgentId: otherAgentId,
      })
      .returning();
    await documentService(ctx.db).upsertIssueDocument({
      issueId: ownerIssue.id,
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "# Plan v1",
      createdByAgentId: ownerAgentId,
    });
    const agentApp = (agentId: string, companyId = company.companyId) =>
      routeApp(
        ctx.db,
        { type: "agent", source: "agent_key", companyId, agentId, runId: null } as never,
        issueRoutes,
      );
    return {
      ...company,
      ownerAgentId,
      makerAgentId,
      otherAgentId,
      ownerIssue,
      stageIssue,
      board: routeApp(ctx.db, company.actor, issueRoutes),
      agentApp,
    };
  }

  async function actions(issueId: string) {
    const rows = await ctx.db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    return rows.map((row) => row.action);
  }

  it("links another task's document, lists it on the linking task, and logs it", async () => {
    const s = await seed();
    const created = await request(s.board)
      .post(`/api/issues/${s.stageIssue.id}/document-links`)
      .send({ sourceIssueId: s.ownerIssue.id, key: "plan" })
      .expect(201);
    expect(created.body).toMatchObject({
      issueId: s.stageIssue.id,
      sourceIssueId: s.ownerIssue.id,
      sourceIssueIdentifier: "SHR-1",
      key: "plan",
      latestRevisionNumber: 1,
      approvedRevisionNumber: null,
    });

    const list = await request(s.board).get(`/api/issues/${s.stageIssue.id}/document-links`).expect(200);
    expect(list.body).toHaveLength(1);

    await request(s.board)
      .post(`/api/issues/${s.stageIssue.id}/document-links`)
      .send({ sourceIssueId: s.ownerIssue.id, key: "plan" })
      .expect(409);
    await request(s.board)
      .post(`/api/issues/${s.ownerIssue.id}/document-links`)
      .send({ sourceIssueId: s.ownerIssue.id, key: "plan" })
      .expect(422);
    await request(s.board)
      .post(`/api/issues/${s.stageIssue.id}/document-links`)
      .send({ sourceIssueId: s.ownerIssue.id, key: "missing" })
      .expect(404);

    expect(await actions(s.stageIssue.id)).toEqual(["issue.document_link_created"]);

    await request(s.board)
      .delete(`/api/issues/${s.stageIssue.id}/document-links/${created.body.id}`)
      .expect(200);
    expect(await ctx.db.select().from(issueDocumentLinks)).toHaveLength(0);
    expect(await actions(s.stageIssue.id)).toContain("issue.document_link_removed");
  });

  it("lets a stage task's assignee link the live document into its own task", async () => {
    const s = await seed();
    await request(s.agentApp(s.otherAgentId))
      .post(`/api/issues/${s.stageIssue.id}/document-links`)
      .send({ sourceIssueId: s.ownerIssue.id, key: "plan" })
      .expect(201);
    const list = await request(s.agentApp(s.otherAgentId))
      .get(`/api/issues/${s.stageIssue.id}/document-links`)
      .expect(200);
    expect(list.body[0]).toMatchObject({ key: "plan", sourceIssueTitle: "Plan the pack" });
  });

  it("keeps links inside one company", async () => {
    const s = await seed();
    const other = await seedCompanyWithBoardAccess(ctx.db, "Other");
    const [foreignIssue] = await ctx.db
      .insert(issues)
      .values({ companyId: other.companyId, title: "Foreign", status: "todo" })
      .returning();
    const foreignBoard = routeApp(ctx.db, other.actor, issueRoutes);

    // Their task cannot point at our document.
    await request(foreignBoard)
      .post(`/api/issues/${foreignIssue.id}/document-links`)
      .send({ sourceIssueId: s.ownerIssue.id, key: "plan" })
      .expect(404);
    // And they cannot see or change our links.
    const read = await request(foreignBoard).get(`/api/issues/${s.stageIssue.id}/document-links`);
    expect([403, 404]).toContain(read.status);
    expect(await ctx.db.select().from(issueDocumentLinks)).toHaveLength(0);
  });

  it("lets the named maker write the document and refuses other agents", async () => {
    const s = await seed();
    const docUrl = `/api/issues/${s.ownerIssue.id}/documents/plan`;

    // Before a maker is named, another agent is refused as today.
    const doc = await documentService(ctx.db).getIssueDocumentByKey(s.ownerIssue.id, "plan");
    const before = await request(s.agentApp(s.makerAgentId))
      .put(docUrl)
      .send({ format: "markdown", body: "# Plan v2", baseRevisionId: doc!.latestRevisionId });
    expect(before.status).toBe(403);
    expect(before.body.error).toBe("Agent cannot mutate another agent's issue");

    // Another agent cannot name itself maker.
    await request(s.agentApp(s.otherAgentId))
      .put(`${docUrl}/maker`)
      .send({ makerAgentId: s.otherAgentId })
      .expect(403);

    const set = await request(s.board)
      .put(`${docUrl}/maker`)
      .send({ makerAgentId: s.makerAgentId })
      .expect(200);
    expect(set.body.makerAgentId).toBe(s.makerAgentId);

    const written = await request(s.agentApp(s.makerAgentId))
      .put(docUrl)
      .send({ format: "markdown", body: "# Plan v2", baseRevisionId: doc!.latestRevisionId })
      .expect(200);
    expect(written.body.latestRevisionNumber).toBe(2);
    const revisions = await ctx.db
      .select()
      .from(documentRevisions)
      .where(eq(documentRevisions.documentId, doc!.id));
    expect(revisions.map((row) => row.createdByAgentId).sort()).toEqual(
      [s.ownerAgentId, s.makerAgentId].sort(),
    );

    // The maker covers that one document only, not new documents on the task.
    await request(s.agentApp(s.makerAgentId))
      .put(`/api/issues/${s.ownerIssue.id}/documents/notes`)
      .send({ format: "markdown", body: "# Notes" })
      .expect(403);

    // Other agents are still refused.
    await request(s.agentApp(s.otherAgentId))
      .put(docUrl)
      .send({ format: "markdown", body: "# Plan v3", baseRevisionId: written.body.latestRevisionId })
      .expect(403);

    // An agent from another company does not even see the task.
    const foreign = await seedCompanyWithBoardAccess(ctx.db, "Foreign");
    const foreignAgentId = await insertAgent(foreign.companyId, "Foreign");
    const crossCompany = await request(s.agentApp(foreignAgentId, foreign.companyId))
      .put(docUrl)
      .send({ format: "markdown", body: "# Plan v3", baseRevisionId: written.body.latestRevisionId });
    expect([403, 404]).toContain(crossCompany.status);

    // A maker from another company cannot be named.
    await request(s.board).put(`${docUrl}/maker`).send({ makerAgentId: foreignAgentId }).expect(422);

    const logged = await actions(s.ownerIssue.id);
    expect(logged).toContain("issue.document_maker_set");
    expect(logged).toContain("issue.document_updated");
  });

  it("marks one revision as the approved version and shows it on links", async () => {
    const s = await seed();
    const docUrl = `/api/issues/${s.ownerIssue.id}/documents/plan`;
    const doc = await documentService(ctx.db).getIssueDocumentByKey(s.ownerIssue.id, "plan");
    await request(s.board)
      .post(`/api/issues/${s.stageIssue.id}/document-links`)
      .send({ sourceIssueId: s.ownerIssue.id, key: "plan" })
      .expect(201);

    // Only the board or the owning assignee may approve.
    await request(s.agentApp(s.otherAgentId))
      .put(`${docUrl}/approved-revision`)
      .send({ revisionId: doc!.latestRevisionId })
      .expect(403);

    const approved = await request(s.board)
      .put(`${docUrl}/approved-revision`)
      .send({ revisionId: doc!.latestRevisionId })
      .expect(200);
    expect(approved.body).toMatchObject({
      approvedRevisionId: doc!.latestRevisionId,
      approvedRevisionNumber: 1,
      approvedByUserId: s.userId,
    });

    const fetched = await request(s.board).get(docUrl).expect(200);
    expect(fetched.body.approvedRevisionNumber).toBe(1);
    const links = await request(s.board).get(`/api/issues/${s.stageIssue.id}/document-links`).expect(200);
    expect(links.body[0].approvedRevisionNumber).toBe(1);

    // A revision from another document is not accepted.
    await request(s.board)
      .put(`${docUrl}/approved-revision`)
      .send({ revisionId: randomUUID() })
      .expect(404);

    // The owning assignee can clear it.
    const cleared = await request(s.agentApp(s.ownerAgentId))
      .put(`${docUrl}/approved-revision`)
      .send({ revisionId: null })
      .expect(200);
    expect(cleared.body.approvedRevisionNumber).toBeNull();

    const logged = await actions(s.ownerIssue.id);
    expect(logged).toContain("issue.document_approved_revision_set");
    expect(logged).toContain("issue.document_approved_revision_cleared");
  });
});
