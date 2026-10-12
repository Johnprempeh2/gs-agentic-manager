import request from "supertest";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import {
  activityLog,
  documentEvidenceLinks,
  documentRevisions,
  documents,
  issueDocuments,
  issues,
} from "@greatstone/db";
import type { DocumentEvidenceExport, DocumentEvidenceView } from "@greatstone/shared";
import { issueRoutes } from "../routes/issues.js";
import { documentService } from "../services/documents.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

const PRE_READ = [
  "# Pre-read",
  "",
  "## Slide 1. Strengths",
  "",
  "- **S1** Revenue was USD 78m, actual. [F2]",
  "- **S2** Three sites. [F1]",
  "",
  "## Slide 3. Environment",
  "",
  "| ID | Line |",
  "|---|---|",
  "| **E1, economic** | 2025 GDP growth 6.6%, estimate. [B1] |",
  "",
  "## Slide 4. Risks",
  "",
  "- **R1** Wheat cost exposure; likelihood medium, suggested, judgement. [F1]",
].join("\n");

const LABELLED = {
  locator: "page 1",
  sourceDate: "2026-10-01",
  type: "actual",
  geography: "Ghana",
  freshness: "current",
} as const;

// GRE-1146: bullet-to-source links and labels on issue documents.
describeEmbeddedPostgres("document evidence routes (GRE-1146)", () => {
  const ctx = useEmbeddedPostgres("gsam-doc-evidence-", {
    resetEach: async (db) => {
      await db.delete(documentEvidenceLinks);
      await db.delete(issueDocuments);
      await db.delete(documentRevisions);
      await db.delete(documents);
      await db.delete(activityLog);
      await db.delete(issues);
      await resetCompanyIssueFixtures(db);
    },
  });

  async function seed(name = "Evidence") {
    const company = await seedCompanyWithBoardAccess(ctx.db, name);
    const [issue] = await ctx.db
      .insert(issues)
      .values({ companyId: company.companyId, title: "Synthesis", status: "in_progress" })
      .returning();
    await documentService(ctx.db).upsertIssueDocument({
      issueId: issue.id,
      key: "pre-read",
      title: "Pre-read",
      format: "markdown",
      body: PRE_READ,
      createdByUserId: company.userId,
    });
    return { ...company, issue, app: routeApp(ctx.db, company.actor, issueRoutes) };
  }

  it("stores links per bullet, shows them with the check, and logs who changed them", async () => {
    const { app, issue, userId } = await seed();

    const put = await request(app)
      .put(`/api/issues/${issue.id}/documents/pre-read/evidence`)
      .send({
        bullets: [
          { bulletId: "S1", sources: [{ sourceId: "F2", ...LABELLED }, { sourceId: "F3", ...LABELLED }] },
          { bulletId: "E1", sources: [{ sourceId: "B1", ...LABELLED, type: "estimate", geography: null }] },
          { bulletId: "R1", sources: [{ sourceId: "F1", ...LABELLED }], judgement: true, inference: true },
        ],
      })
      .expect(200);
    const view = put.body as DocumentEvidenceView;

    expect(view.bullets.map((bullet) => bullet.bulletId)).toEqual(["S1", "S2", "E1", "R1"]);
    const s1 = view.bullets[0];
    expect(s1.section).toBe("Slide 1. Strengths");
    expect(s1.link?.sources.map((source) => source.sourceId)).toEqual(["F2", "F3"]);
    expect(s1.link?.createdByUserId).toBe(userId);
    expect(view.bullets[3].link).toMatchObject({ judgement: true, inference: true });

    expect(view.check.totals).toEqual({ bullets: 4, noSource: 1, labelMissing: 1, judgement: 1, ok: 1 });
    expect(view.check.flagRate).toBe(0.5);
    expect(view.check.pass).toBe(false);
    expect(view.check.bullets.find((bullet) => bullet.bulletId === "E1")?.reasons).toEqual(["B1: geography missing"]);
    expect(view.check.bullets.find((bullet) => bullet.bulletId === "S2")?.category).toBe("no_source");

    const get = await request(app).get(`/api/issues/${issue.id}/documents/pre-read/evidence`).expect(200);
    expect(get.body.check.totals).toEqual(view.check.totals);

    const [activity] = await ctx.db.select().from(activityLog).where(eq(activityLog.entityId, issue.id));
    expect(activity.action).toBe("issue.document_evidence_updated");
    expect(activity.details).toMatchObject({ key: "pre-read", bulletIds: ["S1", "E1", "R1"] });
  });

  it("updates one bullet without touching the others, and keeps markers unless they are sent", async () => {
    const { app, issue } = await seed();
    const url = `/api/issues/${issue.id}/documents/pre-read/evidence`;
    await request(app)
      .put(url)
      .send({ bullets: [
        { bulletId: "S1", sources: [{ sourceId: "F2" }] },
        { bulletId: "R1", sources: [{ sourceId: "F1" }], judgement: true },
      ] })
      .expect(200);
    const res = await request(app)
      .put(url)
      .send({ bullets: [{ bulletId: "R1", sources: [{ sourceId: "F1", ...LABELLED }] }] })
      .expect(200);
    const byId = Object.fromEntries((res.body as DocumentEvidenceView).bullets.map((bullet) => [bullet.bulletId, bullet]));
    expect(byId.S1.link?.sources).toEqual([{ sourceId: "F2", locator: null, geography: null, note: null }]);
    expect(byId.R1.link).toMatchObject({ judgement: true, sources: [{ sourceId: "F1", type: "actual" }] });
    expect(await ctx.db.select().from(documentEvidenceLinks)).toHaveLength(2);
  });

  it("rejects bullet IDs that are not in the document and malformed labels", async () => {
    const { app, issue } = await seed();
    const url = `/api/issues/${issue.id}/documents/pre-read/evidence`;
    const unknown = await request(app)
      .put(url)
      .send({ bullets: [{ bulletId: "S9", sources: [{ sourceId: "F2" }] }] })
      .expect(422);
    expect(unknown.body.details).toEqual({ unknownBulletIds: ["S9"] });

    await request(app)
      .put(url)
      .send({ bullets: [{ bulletId: "S1", sources: [{ sourceId: "F2", type: "guess" }] }] })
      .expect(400);
    await request(app).get(`/api/issues/${issue.id}/documents/missing/evidence`).expect(404);
    expect(await ctx.db.select().from(documentEvidenceLinks)).toHaveLength(0);
  });

  it("keeps another company out", async () => {
    const { issue } = await seed("Owner");
    const other = await seedCompanyWithBoardAccess(ctx.db, "Other");
    const otherApp = routeApp(ctx.db, other.actor, issueRoutes);
    const url = `/api/issues/${issue.id}/documents/pre-read/evidence`;

    const read = await request(otherApp).get(url);
    expect([403, 404]).toContain(read.status);
    const write = await request(otherApp).put(url).send({ bullets: [{ bulletId: "S1", sources: [{ sourceId: "F2" }] }] });
    expect([403, 404]).toContain(write.status);
    expect(await ctx.db.select().from(documentEvidenceLinks)).toHaveLength(0);
  });

  it("shows a link as orphaned when its bullet is edited out, and removes it on delete", async () => {
    const { app, issue, userId } = await seed();
    const url = `/api/issues/${issue.id}/documents/pre-read/evidence`;
    await request(app).put(url).send({ bullets: [{ bulletId: "S2", sources: [{ sourceId: "F1" }] }] }).expect(200);

    const doc = await documentService(ctx.db).getIssueDocumentByKey(issue.id, "pre-read");
    await documentService(ctx.db).upsertIssueDocument({
      issueId: issue.id,
      key: "pre-read",
      title: "Pre-read",
      format: "markdown",
      body: PRE_READ.replace("- **S2** Three sites. [F1]\n", ""),
      baseRevisionId: doc!.latestRevisionId,
      createdByUserId: userId,
    });

    const view = (await request(app).get(url).expect(200)).body as DocumentEvidenceView;
    expect(view.revisionNumber).toBe(2);
    expect(view.bullets.map((bullet) => bullet.bulletId)).toEqual(["S1", "E1", "R1"]);
    expect(view.orphanedLinks.map((link) => link.bulletId)).toEqual(["S2"]);
    expect(view.check.orphanedBulletIds).toEqual(["S2"]);

    await request(app).delete(`${url}/S2`).expect(200);
    await request(app).delete(`${url}/S2`).expect(404);
    await request(app).delete(`${url}/not-an-id`).expect(400);
    expect(await ctx.db.select().from(documentEvidenceLinks)).toHaveLength(0);
  });

  it("exports footnotes, slide notes and the source appendix for the deck", async () => {
    const { app, issue } = await seed();
    const url = `/api/issues/${issue.id}/documents/pre-read/evidence`;
    await request(app)
      .put(url)
      .send({ bullets: [
        { bulletId: "S1", sources: [{ sourceId: "F2", ...LABELLED }] },
        { bulletId: "R1", sources: [{ sourceId: "F2", ...LABELLED, locator: "page 2" }], judgement: true },
      ] })
      .expect(200);

    const exported = (await request(app).get(`${url}/export`).expect(200)).body as DocumentEvidenceExport;
    expect(exported.revisionNumber).toBe(1);
    expect(exported.sections[0].notes).toBe(
      "S1: F2, page 1, 2026-10-01, actual, Ghana, current\nS2: NO SOURCE",
    );
    expect(exported.sections[2].bullets[0].footnote).toBe(
      "F2, page 2, 2026-10-01, actual, Ghana, current [suggested, judgement]",
    );
    expect(exported.sources).toEqual([expect.objectContaining({ sourceId: "F2", citedBy: ["S1", "R1"] })]);

    const markdown = await request(app).get(`${url}/export?format=markdown`).expect(200);
    expect(markdown.headers["content-type"]).toContain("text/markdown");
    expect(markdown.text).toContain("## Evidence appendix");
    expect(markdown.text).toContain("- **E1** NO SOURCE");
  });
});
