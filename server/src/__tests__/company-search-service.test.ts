import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  assets,
  assetTexts,
  companies,
  createDb,
  crmDealProducts,
  crmFiles,
  crmProducts,
  crmTimelineEntries,
  generatedImages,
  organisationContacts,
  organisations,
  documents,
  issueAttachments,
  issueComments,
  issueDocuments,
  issueLabels,
  issues,
  labels,
  pipelineCaseEvidence,
  pipelineCases,
  pipelineStages,
  pipelines,
  projects,
} from "@greatstone/db";
import { companySearchQuerySchema, COMPANY_SEARCH_MAX_QUERY_LENGTH } from "@greatstone/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  COMPANY_SEARCH_BRANCH_FETCH_LIMIT,
  companySearchBranchFetchLimit,
  companySearchService,
} from "../services/company-search.js";
import { quietClientsService } from "../services/quiet-clients.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company search tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("company search query validation", () => {
  it("truncates long text queries but rejects invalid filters, sort, and pagination", () => {
    const parsed = companySearchQuerySchema.parse({
      q: "x".repeat(COMPANY_SEARCH_MAX_QUERY_LENGTH + 50),
      limit: "50",
      offset: "200",
      scope: "all",
      status: "todo,blocked",
      priority: ["critical", "low"],
      sort: "priority",
      updatedWithin: "7d",
    });

    expect(parsed.q).toHaveLength(COMPANY_SEARCH_MAX_QUERY_LENGTH);
    expect(parsed.status).toEqual(["todo", "blocked"]);
    expect(parsed.priority).toEqual(["critical", "low"]);
    expect(parsed.sort).toBe("priority");
    expect(parsed.updatedWithin).toBe("7d");
    expect(() => companySearchQuerySchema.parse({ q: "needle", limit: "500" })).toThrow();
    expect(() => companySearchQuerySchema.parse({ q: "needle", offset: "9000" })).toThrow();
    expect(() => companySearchQuerySchema.parse({ q: "needle", scope: "not-a-scope" })).toThrow();
    expect(() => companySearchQuerySchema.parse({ q: "needle", status: "not-a-status" })).toThrow();
    expect(() => companySearchQuerySchema.parse({ q: "needle", priority: "urgent" })).toThrow();
    expect(() => companySearchQuerySchema.parse({ q: "needle", sort: "oldest" })).toThrow();
    expect(() => companySearchQuerySchema.parse({ q: "needle", updatedWithin: "forever" })).toThrow();
    expect(() => companySearchQuerySchema.parse({ q: "needle", projectId: "not-a-uuid" })).toThrow();
  });

  it("includes offset in the internal per-branch fetch window", () => {
    const lowOffset = companySearchQuerySchema.parse({ q: "needle", limit: "50", offset: "0" });
    const highOffset = companySearchQuerySchema.parse({ q: "needle", limit: "50", offset: "200" });

    expect(companySearchBranchFetchLimit(lowOffset.limit, lowOffset.offset)).toBe(51);
    expect(companySearchBranchFetchLimit(highOffset.limit, highOffset.offset)).toBe(COMPANY_SEARCH_BRANCH_FETCH_LIMIT);
  });
});

describeEmbeddedPostgres("companySearchService", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof companySearchService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-search-");
    db = createDb(tempDb.connectionString);
    svc = companySearchService(db);
    await db.execute(sql.raw("CREATE EXTENSION IF NOT EXISTS pg_trgm"));
  }, 20_000);

  afterEach(async () => {
    await db.delete(crmFiles);
    await db.delete(crmTimelineEntries);
    await db.delete(crmDealProducts);
    await db.delete(crmProducts);
    await db.delete(generatedImages);
    await db.delete(organisationContacts);
    await db.delete(pipelineCaseEvidence);
    await db.delete(pipelineCases);
    await db.delete(pipelineStages);
    await db.delete(pipelines);
    await db.delete(organisations);
    await db.delete(assetTexts);
    await db.delete(issueAttachments);
    await db.delete(assets);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(issueLabels);
    await db.delete(issues);
    await db.delete(labels);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(name = "GS Agentic Manager") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function createIssue(companyId: string, values: Partial<typeof issues.$inferInsert> = {}) {
    const id = values.id ?? randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: values.title ?? "Search target",
      description: values.description ?? null,
      status: values.status ?? "todo",
      priority: values.priority ?? "medium",
      identifier: values.identifier ?? null,
      hiddenAt: values.hiddenAt ?? null,
      ...values,
    });
    return id;
  }

  async function createAgent(companyId: string, values: Partial<typeof agents.$inferInsert> = {}) {
    const id = values.id ?? randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: values.name ?? "Search agent",
      role: values.role ?? "engineer",
      title: values.title ?? null,
      capabilities: values.capabilities ?? null,
      ...values,
    });
    return id;
  }

  async function createProject(companyId: string, values: Partial<typeof projects.$inferInsert> = {}) {
    const id = values.id ?? randomUUID();
    await db.insert(projects).values({
      id,
      companyId,
      name: values.name ?? "Search project",
      description: values.description ?? null,
      ...values,
    });
    return id;
  }

  async function createLabel(companyId: string, values: Partial<typeof labels.$inferInsert> = {}) {
    const id = values.id ?? randomUUID();
    await db.insert(labels).values({
      id,
      companyId,
      name: values.name ?? "Search label",
      color: values.color ?? "blue",
      ...values,
    });
    return id;
  }

  async function createAsset(companyId: string, filename: string, contentType: string, text: string | null) {
    const id = randomUUID();
    await db.insert(assets).values({
      id,
      companyId,
      provider: "local_disk",
      objectKey: `${companyId}/${id}`,
      contentType,
      byteSize: 10,
      sha256: id,
      originalFilename: filename,
    });
    if (text !== null) await db.insert(assetTexts).values({ assetId: id, companyId, status: "indexed", text });
    return id;
  }

  it("finds words inside uploaded files and shows the matching line", async () => {
    const companyId = await createCompany();
    const issueId = await createIssue(companyId, { identifier: "TST-5", title: "Board chat" });
    const chatAsset = await createAsset(companyId, "terms.pdf", "application/pdf", "Engagement terms\nThe retainer is 4,000 a month\nSigned by both parties");
    const [attachment] = await db.insert(issueAttachments).values({ companyId, issueId, assetId: chatAsset }).returning();

    const pipelineId = randomUUID();
    const stageId = randomUUID();
    const caseId = randomUUID();
    await db.insert(pipelines).values({ id: pipelineId, companyId, key: "clients", name: "Clients" });
    await db.insert(pipelineStages).values({ id: stageId, companyId, pipelineId, key: "lead", name: "Lead", kind: "working", position: 0 });
    await db.insert(pipelineCases).values({ id: caseId, companyId, pipelineId, stageId, caseKey: "acme", title: "Acme Ltd" });
    const ndaAsset = await createAsset(companyId, "nda.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "Mutual NDA\nThe retainer terms stay confidential for two years");
    await db.insert(pipelineCaseEvidence).values({ companyId, caseId, kind: "upload", title: "NDA", assetId: ndaAsset });
    // A file nobody can open from a task or client is never shown.
    await createAsset(companyId, "orphan.txt", "text/plain", "retainer orphan");

    const result = await svc.search(companyId, companySearchQuerySchema.parse({ q: "retainer", scope: "files" }));

    expect(result.countsByType.file).toBe(2);
    const byName = new Map(result.results.map((row) => [row.title, row]));
    expect(byName.get("terms.pdf")).toMatchObject({
      type: "file",
      href: expect.stringContaining(`/issues/TST-5`),
      snippet: "The retainer is 4,000 a month",
      file: expect.objectContaining({ owner: expect.objectContaining({ kind: "task" }), contentPath: `/api/attachments/${attachment!.id}/content` }),
    });
    expect(byName.get("nda.docx")).toMatchObject({
      href: expect.stringContaining(`/pipelines/${pipelineId}/items/${caseId}`),
      snippet: "The retainer terms stay confidential for two years",
      file: expect.objectContaining({ owner: { kind: "client", label: "Acme Ltd", href: expect.any(String) } }),
    });
    expect(byName.has("orphan.txt")).toBe(false);

    const all = await svc.search(companyId, companySearchQuerySchema.parse({ q: "retainer confidential" }));
    expect(all.results.filter((row) => row.type === "file").map((row) => row.title)).toEqual(["nda.docx"]);
  });

  it("finds words in files imported from the CRM, under their organisation", async () => {
    const companyId = await createCompany();
    const orgId = randomUUID();
    await db.insert(organisations).values({ id: orgId, companyId, name: "Osprey plc" });
    const assetId = await createAsset(companyId, null as unknown as string, "application/pdf", "Board minutes\nOsprey agreed the warranty terms");
    await db.insert(crmFiles).values({ companyId, source: "pipedrive", externalId: "f1", name: "minutes.pdf", assetId, organisationId: orgId });

    const result = await svc.search(companyId, companySearchQuerySchema.parse({ q: "warranty", scope: "files" }));
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      title: "minutes.pdf",
      href: expect.stringContaining(`/organisations/${orgId}`),
      snippet: "Osprey agreed the warranty terms",
      file: expect.objectContaining({ owner: expect.objectContaining({ kind: "organisation", label: "Osprey plc" }) }),
    });
  });

  it("finds images by their alt text, and hides files on hidden tasks", async () => {
    const companyId = await createCompany();
    const issueId = await createIssue(companyId, { identifier: "TST-6", title: "Brand review" });
    const imageAsset = await createAsset(companyId, "logo.png", "image/png", null);
    const [image] = await db.insert(issueAttachments).values({ companyId, issueId, assetId: imageAsset }).returning();
    await db.insert(issueComments).values({
      companyId,
      issueId,
      body: `Here it is ![Blue mountain logo on white](/api/attachments/${image!.id}/content) and more`,
    });
    const hiddenIssueId = await createIssue(companyId, { identifier: "TST-7", title: "Hidden", hiddenAt: new Date() });
    const hiddenAsset = await createAsset(companyId, "hidden.txt", "text/plain", "mountain secrets");
    await db.insert(issueAttachments).values({ companyId, issueId: hiddenIssueId, assetId: hiddenAsset });

    const result = await svc.search(companyId, companySearchQuerySchema.parse({ q: "mountain logo", scope: "files" }));
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      type: "file",
      title: "logo.png",
      snippet: "Blue mountain logo on white",
      previewImageUrl: `/api/attachments/${image!.id}/content`,
      file: expect.objectContaining({ mediaKind: "image", matchedAltText: true }),
    });

    const hidden = await svc.search(companyId, companySearchQuerySchema.parse({ q: "mountain secrets", scope: "files" }));
    expect(hidden.results).toHaveLength(0);
  });

  it("finds organisations, people, clients, products and images", async () => {
    const companyId = await createCompany();
    const orgId = randomUUID();
    await db.insert(organisations).values([
      { id: orgId, companyId, name: "Kestrel Holdings", industry: "Finance", country: "UK" },
      { companyId, name: "Kestrel Archive", archivedAt: new Date() },
    ]);
    await db.insert(organisationContacts).values({ companyId, organisationId: orgId, name: "Ada Kestrel", role: "CFO", email: "ada@example.com" });
    const pipelineId = randomUUID();
    const stageId = randomUUID();
    const caseId = randomUUID();
    await db.insert(pipelines).values({ id: pipelineId, companyId, key: "sales", name: "Sales" });
    await db.insert(pipelineStages).values({ id: stageId, companyId, pipelineId, key: "proposal", name: "Proposal", kind: "working", position: 0 });
    await db.insert(pipelineCases).values([
      { id: caseId, companyId, pipelineId, stageId, caseKey: "pipedrive-deal-1", title: "Kestrel renewal" },
      { companyId, pipelineId, stageId, caseKey: "old", title: "Kestrel retired deal", retiredAt: new Date() },
    ]);
    const productId = randomUUID();
    await db.insert(crmProducts).values({ id: productId, companyId, source: "pipedrive", externalId: "9", name: "Kestrel licence", code: "KL-1" });
    await db.insert(crmDealProducts).values({ companyId, source: "pipedrive", externalId: "line-1", caseId, productId, name: "Kestrel licence" });
    const assetId = randomUUID();
    await db.insert(assets).values({ id: assetId, companyId, provider: "local_disk", objectKey: "k", contentType: "image/png", byteSize: 1, sha256: "x" });
    await db.insert(generatedImages).values({ companyId, prompt: "A kestrel over hills", aspectRatio: "1:1", provider: "higgsfield", model: "m", status: "completed", assetId });
    const otherCompany = await createCompany("Other");
    await db.insert(organisations).values({ companyId: otherCompany, name: "Kestrel Elsewhere" });

    const result = await svc.search(companyId, companySearchQuerySchema.parse({ q: "kestrel", scope: "records" }));

    const byTitle = new Map(result.results.map((row) => [row.title, row]));
    expect([...byTitle.keys()].sort()).toEqual(["A kestrel over hills", "Ada Kestrel", "Kestrel Holdings", "Kestrel licence", "Kestrel renewal"]);
    expect(result.countsByType.record).toBe(5);
    expect(byTitle.get("Kestrel Holdings")).toMatchObject({ type: "record", href: expect.stringMatching(new RegExp(`/organisations/${orgId}$`)), record: { kind: "organisation", subtitle: "Finance, UK" } });
    expect(byTitle.get("Ada Kestrel")?.record).toEqual({ kind: "person", subtitle: "CFO at Kestrel Holdings" });
    expect(byTitle.get("Kestrel renewal")).toMatchObject({ href: expect.stringContaining(`/pipelines/${pipelineId}/items/${caseId}`), record: { kind: "client", subtitle: "Proposal in Sales" } });
    expect(byTitle.get("Kestrel licence")).toMatchObject({ href: expect.stringContaining(`/items/${caseId}`), record: { kind: "product", subtitle: "KL-1, on Kestrel renewal" } });
    expect(byTitle.get("A kestrel over hills")).toMatchObject({ previewImageUrl: `/api/assets/${assetId}/content`, record: { kind: "image" } });

    const onlyPeopleAndProducts = await svc.search(companyId, companySearchQuerySchema.parse({ q: "kestrel", scope: "records", recordKind: "person,product" }));
    expect(onlyPeopleAndProducts.results.map((row) => row.title).sort()).toEqual(["Ada Kestrel", "Kestrel licence"]);
    expect(onlyPeopleAndProducts.countsByType.record).toBe(2);

    const people = await svc.search(companyId, companySearchQuerySchema.parse({ q: "ada@example.com" }));
    expect(people.results.filter((row) => row.type === "record").map((row) => row.title)).toEqual(["Ada Kestrel"]);
  });

  it("finds imported notes, calls and meetings under their deal or organisation", async () => {
    const companyId = await createCompany();
    const orgId = randomUUID();
    await db.insert(organisations).values({ id: orgId, companyId, name: "Merlin Ltd" });
    const pipelineId = randomUUID();
    const stageId = randomUUID();
    const caseId = randomUUID();
    await db.insert(pipelines).values({ id: pipelineId, companyId, key: "sales", name: "Sales" });
    await db.insert(pipelineStages).values({ id: stageId, companyId, pipelineId, key: "proposal", name: "Proposal", kind: "working", position: 0 });
    await db.insert(pipelineCases).values({ id: caseId, companyId, pipelineId, stageId, caseKey: "pipedrive-deal-2", title: "Merlin rollout" });
    await db.insert(crmTimelineEntries).values([
      { companyId, source: "pipedrive", externalId: "a1", kind: "activity", activityType: "call", subject: "Pricing call", body: "Talked through the falcon tier", occurredAt: new Date("2026-10-12T10:00:00Z"), organisationId: orgId, caseId },
      { companyId, source: "pipedrive", externalId: "n1", kind: "note", body: "Falcon budget signed off by the board", organisationId: orgId },
      { companyId, source: "pipedrive", externalId: "s1", kind: "stage_change", subject: "Falcon moved stage", caseId },
    ]);

    const result = await svc.search(companyId, companySearchQuerySchema.parse({ q: "falcon", scope: "records" }));

    const byTitle = new Map(result.results.map((row) => [row.title, row]));
    expect([...byTitle.keys()].sort()).toEqual(["Falcon budget signed off by the board", "Pricing call"]);
    expect(byTitle.get("Pricing call")).toMatchObject({ href: expect.stringContaining(`/pipelines/${pipelineId}/items/${caseId}`), record: { kind: "activity", subtitle: "Call, Merlin rollout, 12 Oct 2026" } });
    expect(byTitle.get("Falcon budget signed off by the board")).toMatchObject({ href: expect.stringMatching(new RegExp(`/organisations/${orgId}$`)), record: { kind: "activity", subtitle: "Note, Merlin Ltd" } });

    // Asking about the client by name finds its history even when the note never says the name.
    const byClient = await svc.search(companyId, companySearchQuerySchema.parse({ q: "merlin", scope: "records", recordKind: "activity" }));
    expect(byClient.results.map((row) => row.title).sort()).toEqual(["Falcon budget signed off by the board", "Pricing call"]);
  });

  it("finds the people at an organisation by the organisation's name", async () => {
    const companyId = await createCompany();
    const orgId = randomUUID();
    await db.insert(organisations).values({ id: orgId, companyId, name: "Osprey Holdings" });
    await db.insert(organisationContacts).values({ companyId, organisationId: orgId, name: "Ada Kestrel", role: "CFO" });
    const result = await svc.search(companyId, companySearchQuerySchema.parse({ q: "osprey", scope: "records", recordKind: "person" }));
    expect(result.results.map((row) => row.title)).toEqual(["Ada Kestrel"]);
    expect(result.results[0]?.record).toMatchObject({ kind: "person", subtitle: "CFO at Osprey Holdings" });
  });

  it("lists open deals with no note, call or meeting for a while, quietest first", async () => {
    const companyId = await createCompany();
    const now = new Date("2026-10-18T09:00:00Z");
    const orgId = randomUUID();
    await db.insert(organisations).values({ id: orgId, companyId, name: "Heron Ltd" });
    const pipelineId = randomUUID();
    const working = randomUUID();
    const done = randomUUID();
    await db.insert(pipelines).values({ id: pipelineId, companyId, key: "sales", name: "Sales" });
    await db.insert(pipelineStages).values([
      { id: working, companyId, pipelineId, key: "proposal", name: "Proposal", kind: "working", position: 0 },
      { id: done, companyId, pipelineId, key: "won", name: "Won", kind: "done", position: 1 },
    ]);
    const [quiet, recent, never, won] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const old = new Date("2026-08-01T09:00:00Z");
    await db.insert(pipelineCases).values([
      { id: quiet, companyId, pipelineId, stageId: working, caseKey: "q", title: "Heron rollout", organisationId: orgId, createdAt: old },
      { id: recent, companyId, pipelineId, stageId: working, caseKey: "r", title: "Kite pilot", createdAt: old },
      { id: never, companyId, pipelineId, stageId: working, caseKey: "n", title: "Wren lead", createdAt: new Date("2026-09-01T09:00:00Z") },
      { id: won, companyId, pipelineId, stageId: done, caseKey: "w", title: "Owl deal", createdAt: old },
    ]);
    await db.insert(crmTimelineEntries).values([
      // Heron: last call on the organisation 50 days ago; a later stage change does not count.
      { companyId, source: "pipedrive", externalId: "h1", kind: "activity", activityType: "call", subject: "Pricing call", occurredAt: new Date("2026-08-29T09:00:00Z"), organisationId: orgId },
      { companyId, source: "pipedrive", externalId: "h2", kind: "stage_change", subject: "Moved", occurredAt: new Date("2026-10-17T09:00:00Z"), caseId: quiet },
      { companyId, source: "pipedrive", externalId: "k1", kind: "note", body: "Agreed next steps", occurredAt: new Date("2026-10-10T09:00:00Z"), caseId: recent },
    ]);

    const result = await quietClientsService(db).list(companyId, { days: 30, limit: 10, now });

    expect(result.total).toBe(2);
    expect(result.clients.map((client) => client.title)).toEqual(["Heron rollout", "Wren lead"]);
    expect(result.clients[0]).toMatchObject({
      organisationName: "Heron Ltd",
      stageName: "Proposal",
      lastTouchLabel: "Call: Pricing call",
      quietDays: 50,
      href: expect.stringContaining(`/pipelines/${pipelineId}/items/${quiet}`),
    });
    expect(result.clients[1]).toMatchObject({ lastTouchAt: null, lastTouchLabel: null, quietDays: 47 });
  });

  it("lists recent client notes, calls and meetings with counts by kind", async () => {
    const companyId = await createCompany();
    const now = new Date("2026-10-18T09:00:00Z");
    const orgId = randomUUID();
    await db.insert(organisations).values({ id: orgId, companyId, name: "Heron Ltd" });
    await db.insert(crmTimelineEntries).values([
      { companyId, source: "pipedrive", externalId: "r1", kind: "activity", activityType: "call", subject: "Pricing call", ownerName: "Ama", occurredAt: new Date("2026-10-17T09:00:00Z"), organisationId: orgId },
      { companyId, source: "pipedrive", externalId: "r2", kind: "note", body: "<p>Sent the <b>proposal</b></p>", occurredAt: new Date("2026-10-15T09:00:00Z"), organisationId: orgId },
      { companyId, source: "pipedrive", externalId: "r3", kind: "activity", activityType: "call", subject: "Old call", occurredAt: new Date("2026-09-01T09:00:00Z"), organisationId: orgId },
      { companyId, source: "pipedrive", externalId: "r4", kind: "stage_change", subject: "Moved", occurredAt: new Date("2026-10-17T10:00:00Z"), organisationId: orgId },
    ]);

    const result = await quietClientsService(db).recentActivity(companyId, { days: 7, limit: 10, now });

    expect(result).toMatchObject({ days: 7, total: 2, clientCount: 1, byKind: [["Call", 1], ["Note", 1]] });
    expect(result.activity.map((entry) => entry.title)).toEqual(["Pricing call", "Sent the proposal"]);
    expect(result.activity[0]).toMatchObject({ kindLabel: "Call", clientName: "Heron Ltd", ownerName: "Ama", href: expect.stringMatching(new RegExp(`/organisations/${orgId}$`)) });
    expect(await quietClientsService(db).recentActivity(companyId, { days: 1, limit: 10, now: new Date("2026-12-01T00:00:00Z") })).toMatchObject({ total: 0, clientCount: 0, byKind: [], activity: [] });
    const sinceVisit = await quietClientsService(db).recentActivity(companyId, { days: 7, limit: 10, now, since: new Date("2026-10-16T00:00:00Z") });
    expect(sinceVisit.activity.map((entry) => entry.title)).toEqual(["Pricing call"]);
  });

  it("finds organisations and people by their imported CRM fields", async () => {
    const companyId = await createCompany();
    const orgId = randomUUID();
    await db.insert(organisations).values({
      id: orgId,
      companyId,
      name: "Plover Ltd",
      crmFields: [
        { key: "sector", label: "Sector", value: "Aquaculture" },
        { key: "tags", label: "Tags", value: ["shortlist", "west"] },
        { key: "headcount", label: "Headcount", value: 42 },
      ],
    });
    await db.insert(organisationContacts).values({ companyId, organisationId: orgId, name: "Kofi Mensah", crmFields: [{ key: "source", label: "Lead source", value: "Trade fair" }] });

    const bySector = await svc.search(companyId, companySearchQuerySchema.parse({ q: "aquaculture", scope: "records" }));
    expect(bySector.results.map((row) => row.title)).toEqual(["Plover Ltd"]);
    const byTag = await svc.search(companyId, companySearchQuerySchema.parse({ q: "shortlist", scope: "records" }));
    expect(byTag.results.map((row) => row.title)).toEqual(["Plover Ltd"]);
    const bySource = await svc.search(companyId, companySearchQuerySchema.parse({ q: "trade fair", scope: "records", recordKind: "person" }));
    expect(bySource.results.map((row) => row.title)).toEqual(["Kofi Mensah"]);
    expect((await svc.search(companyId, companySearchQuerySchema.parse({ q: "42", scope: "records" }))).results).toEqual([]);
  });

  it("briefs on the best-matching organisation: people, open deals and last contact", async () => {
    const companyId = await createCompany();
    const now = new Date("2026-10-18T09:00:00Z");
    const [orgId, otherId] = [randomUUID(), randomUUID()];
    await db.insert(organisations).values([
      { id: otherId, companyId, name: "Grebe Holdings International" },
      { id: orgId, companyId, name: "Grebe", status: "client", industry: "Mining", country: "Ghana" },
    ]);
    await db.insert(organisationContacts).values([
      { companyId, organisationId: orgId, name: "Esi Boateng", role: "COO" },
      { companyId, organisationId: orgId, name: "Yaw Darko", role: "CFO", isKeyContact: true },
    ]);
    const pipelineId = randomUUID();
    const [working, done] = [randomUUID(), randomUUID()];
    await db.insert(pipelines).values({ id: pipelineId, companyId, key: "sales", name: "Sales" });
    await db.insert(pipelineStages).values([
      { id: working, companyId, pipelineId, key: "proposal", name: "Proposal", kind: "working", position: 0 },
      { id: done, companyId, pipelineId, key: "won", name: "Won", kind: "done", position: 1 },
    ]);
    const caseId = randomUUID();
    await db.insert(pipelineCases).values([
      { id: caseId, companyId, pipelineId, stageId: working, caseKey: "g1", title: "Grebe expansion", organisationId: orgId, fields: { dealValue: 12000, dealCurrency: "GBP", expectedCloseDate: "2026-11-30" } },
      { companyId, pipelineId, stageId: done, caseKey: "g0", title: "Grebe pilot", organisationId: orgId },
    ]);
    await db.insert(crmTimelineEntries).values([
      { companyId, source: "pipedrive", externalId: "g-1", kind: "activity", activityType: "meeting", subject: "Quarterly review", occurredAt: new Date("2026-10-08T09:00:00Z"), caseId },
      { companyId, source: "pipedrive", externalId: "g-2", kind: "note", body: "Older note", occurredAt: new Date("2026-09-01T09:00:00Z"), organisationId: orgId },
    ]);

    const { brief } = await quietClientsService(db).clientBrief(companyId, "grebe", { now });

    expect(brief).toMatchObject({
      organisation: { id: orgId, name: "Grebe", status: "client", industry: "Mining", country: "Ghana" },
      peopleCount: 2,
      openDeals: [{ title: "Grebe expansion", stageName: "Proposal", pipelineName: "Sales", value: 12000, currency: "GBP", expectedCloseDate: "2026-11-30" }],
      lastTouch: { label: "Meeting: Quarterly review" },
      quietDays: 10,
    });
    expect(brief!.people.map((person) => person.name)).toEqual(["Yaw Darko", "Esi Boateng"]);
    expect((await quietClientsService(db).clientBrief(companyId, "nobody")).brief).toBeNull();
    expect((await quietClientsService(db).clientBrief(companyId, "%")).brief).toBeNull();
  });

  it("lists open deals by expected close date with overdue ones and value per currency", async () => {
    const companyId = await createCompany();
    const now = new Date("2026-10-18T09:00:00Z");
    const pipelineId = randomUUID();
    const [working, done] = [randomUUID(), randomUUID()];
    await db.insert(pipelines).values({ id: pipelineId, companyId, key: "sales", name: "Sales" });
    await db.insert(pipelineStages).values([
      { id: working, companyId, pipelineId, key: "proposal", name: "Proposal", kind: "working", position: 0 },
      { id: done, companyId, pipelineId, key: "won", name: "Won", kind: "done", position: 1 },
    ]);
    await db.insert(pipelineCases).values([
      { companyId, pipelineId, stageId: working, caseKey: "c1", title: "Late renewal", fields: { expectedCloseDate: "2026-10-10", dealValue: 5000, dealCurrency: "GBP" } },
      { companyId, pipelineId, stageId: working, caseKey: "c2", title: "Next week", fields: { expectedCloseDate: "2026-10-25", dealValue: 2500, dealCurrency: "GBP" } },
      { companyId, pipelineId, stageId: working, caseKey: "c3", title: "Lead in dollars", fields: { expectedCloseDate: "2026-11-01", leadValue: 900, leadCurrency: "USD" } },
      { companyId, pipelineId, stageId: working, caseKey: "c4", title: "Next year", fields: { expectedCloseDate: "2027-03-01", dealValue: 1, dealCurrency: "GBP" } },
      { companyId, pipelineId, stageId: working, caseKey: "c5", title: "No date", fields: { dealValue: 7 } },
      { companyId, pipelineId, stageId: working, caseKey: "c6", title: "Bad date", fields: { expectedCloseDate: "soon" } },
      { companyId, pipelineId, stageId: done, caseKey: "c7", title: "Already won", fields: { expectedCloseDate: "2026-10-20", dealValue: 99 } },
    ]);

    const result = await quietClientsService(db).closing(companyId, { days: 30, limit: 10, now });

    expect(result.deals.map((deal) => deal.title)).toEqual(["Late renewal", "Next week", "Lead in dollars"]);
    expect(result.deals[0]).toMatchObject({ overdue: true, value: 5000, currency: "GBP", stageName: "Proposal", pipelineName: "Sales", expectedCloseDate: "2026-10-10" });
    expect(result.deals[2]).toMatchObject({ overdue: false, value: 900, currency: "USD" });
    expect(result).toMatchObject({ days: 30, total: 3, overdueCount: 1 });
    expect(result.valueByCurrency).toEqual([
      { currency: "GBP", value: 7500, count: 2 },
      { currency: "USD", value: 900, count: 1 },
    ]);
    const limited = await quietClientsService(db).closing(companyId, { days: 30, limit: 1, now });
    expect(limited).toMatchObject({ total: 3, deals: [{ title: "Late renewal" }] });
    expect((await quietClientsService(db).closing(companyId, { days: 0, limit: 10, now })).deals.map((deal) => deal.title)).toEqual(["Late renewal"]);
  });

  it("summarises open deals per stage with value per currency and the largest deals", async () => {
    const companyId = await createCompany();
    const pipelineId = randomUUID();
    const [lead, proposal, done] = [randomUUID(), randomUUID(), randomUUID()];
    await db.insert(pipelines).values({ id: pipelineId, companyId, key: "sales", name: "Sales" });
    await db.insert(pipelineStages).values([
      { id: proposal, companyId, pipelineId, key: "proposal", name: "Proposal", kind: "working", position: 1 },
      { id: lead, companyId, pipelineId, key: "lead", name: "Lead", kind: "working", position: 0 },
      { id: done, companyId, pipelineId, key: "won", name: "Won", kind: "done", position: 2 },
    ]);
    await db.insert(pipelineCases).values([
      { companyId, pipelineId, stageId: lead, caseKey: "p1", title: "Small lead", fields: { leadValue: 100, leadCurrency: "GBP", leadOwner: "Ama" } },
      { companyId, pipelineId, stageId: lead, caseKey: "p2", title: "Unpriced lead", fields: {} },
      { companyId, pipelineId, stageId: proposal, caseKey: "p3", title: "Big proposal", fields: { dealValue: 9000, dealCurrency: "GBP", expectedCloseDate: "2026-11-01", dealOwner: "Kofi" } },
      { companyId, pipelineId, stageId: proposal, caseKey: "p4", title: "Dollar proposal", fields: { dealValue: 3000, dealCurrency: "USD", dealOwner: "Kofi" } },
      { companyId, pipelineId, stageId: done, caseKey: "p5", title: "Already won", fields: { dealValue: 99999, dealCurrency: "GBP" } },
    ]);

    const summary = await quietClientsService(db).pipelineSummary(companyId, { limit: 2 });

    expect(summary.total).toBe(4);
    expect(summary.stages).toEqual([
      { pipelineId, pipelineName: "Sales", stageName: "Lead", count: 2, valueByCurrency: [{ currency: "GBP", value: 100 }] },
      expect.objectContaining({ stageName: "Proposal", count: 2 }),
    ]);
    expect(summary.valueByCurrency).toEqual([
      { currency: "GBP", value: 9100, count: 2 },
      { currency: "USD", value: 3000, count: 1 },
      { currency: null, value: 0, count: 1 },
    ]);
    expect(summary.topDeals.map((deal) => deal.title)).toEqual(["Big proposal", "Dollar proposal"]);
    expect(summary.topDeals[0]).toMatchObject({ value: 9000, currency: "GBP", stageName: "Proposal", expectedCloseDate: "2026-11-01" });
    expect(summary.owners).toEqual([
      { owner: "Kofi", count: 2, valueByCurrency: [{ currency: "GBP", value: 9000 }, { currency: "USD", value: 3000 }] },
      { owner: "Ama", count: 1, valueByCurrency: [{ currency: "GBP", value: 100 }] },
      { owner: null, count: 1, valueByCurrency: [] },
    ]);
    expect(summary.missing).toMatchObject({ closeDate: 3, value: 1, owner: 1, organisation: 4 });
    expect(summary.missing.deals).toHaveLength(2);
    expect(summary.missing.deals.every((deal) => deal.missing.includes("organisation"))).toBe(true);
    const all = await quietClientsService(db).pipelineSummary(companyId, { limit: 10 });
    expect(all.missing.deals.find((deal) => deal.title === "Unpriced lead")?.missing).toEqual(["closeDate", "value", "owner", "organisation"]);
    expect(all.missing.deals.find((deal) => deal.title === "Big proposal")?.missing).toEqual(["organisation"]);
  });

  it("lists deals won and lost in the window with value and lost reasons", async () => {
    const companyId = await createCompany();
    const now = new Date("2026-10-18T09:00:00Z");
    const pipelineId = randomUUID();
    const [working, won, lost] = [randomUUID(), randomUUID(), randomUUID()];
    await db.insert(pipelines).values({ id: pipelineId, companyId, key: "sales", name: "Sales" });
    await db.insert(pipelineStages).values([
      { id: working, companyId, pipelineId, key: "proposal", name: "Proposal", kind: "working", position: 0 },
      { id: won, companyId, pipelineId, key: "won", name: "Won", kind: "done", position: 1 },
      { id: lost, companyId, pipelineId, key: "lost", name: "Lost", kind: "cancelled", position: 2 },
    ]);
    await db.insert(pipelineCases).values([
      { companyId, pipelineId, stageId: won, caseKey: "w1", title: "Imported win", fields: { wonOn: "2026-10-01", dealValue: 4000, dealCurrency: "GBP" }, terminalAt: new Date("2026-10-17T00:00:00Z") },
      { companyId, pipelineId, stageId: won, caseKey: "w2", title: "Recent win", terminalAt: new Date("2026-10-15T12:00:00Z"), fields: { dealValue: 1000, dealCurrency: "GBP" } },
      { companyId, pipelineId, stageId: won, caseKey: "w3", title: "Old win", fields: { wonOn: "2025-01-01", dealValue: 99 } },
      { companyId, pipelineId, stageId: lost, caseKey: "l1", title: "Lost on price", fields: { lostOn: "2026-10-10", lostReason: "Price", dealValue: 500, dealCurrency: "GBP" } },
      { companyId, pipelineId, stageId: lost, caseKey: "l2", title: "Lost again", fields: { lostOn: "2026-10-12", lostReason: "Price" } },
      { companyId, pipelineId, stageId: lost, caseKey: "l3", title: "Went quiet", fields: { lostOn: "2026-10-11", lostReason: "No response" } },
      { companyId, pipelineId, stageId: working, caseKey: "o1", title: "Still open", fields: { wonOn: "2026-10-10" } },
    ]);

    const result = await quietClientsService(db).wonLost(companyId, { days: 30, limit: 5, now });

    expect(result.won).toMatchObject({ count: 2, valueByCurrency: [{ currency: "GBP", value: 5000 }] });
    expect(result.won.deals.map((deal) => [deal.title, deal.closedOn])).toEqual([["Recent win", "2026-10-15"], ["Imported win", "2026-10-01"]]);
    expect(result.lost.count).toBe(3);
    expect(result.lost.deals[0]).toMatchObject({ title: "Lost again", lostReason: "Price", value: null });
    expect(result.lost.reasons).toEqual([{ reason: "Price", count: 2 }, { reason: "No response", count: 1 }]);
    const limited = await quietClientsService(db).wonLost(companyId, { days: 30, limit: 1, now });
    expect(limited.lost).toMatchObject({ count: 3, deals: [{ title: "Lost again" }] });
  });

  it("keeps exact entity names ahead of speculative task typos and rejects empty quotes", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, { name: "Mibile" });
    const projectId = await createProject(companyId, { name: "Mibile" });
    const taskId = await createIssue(companyId, { title: "Mobile navigation" });
    const result = await svc.search(companyId, companySearchQuerySchema.parse({ q: "mibile" }));
    const ids = result.results.map((row) => row.id);
    expect(ids).toContain(taskId);
    expect(ids.indexOf(agentId)).toBeLessThan(ids.indexOf(taskId));
    expect(ids.indexOf(projectId)).toBeLessThan(ids.indexOf(taskId));
    expect((await svc.search(companyId, companySearchQuerySchema.parse({ q: '""' }))).results).toEqual([]);
  });

  it("ranks exact issue identifiers before weaker title matches", async () => {
    const companyId = await createCompany();
    const exactId = await createIssue(companyId, {
      identifier: "TST-42",
      title: "Backend endpoint",
    });
    await createIssue(companyId, {
      identifier: "TST-43",
      title: "TST-42 mentioned in title only",
    });

    const result = await svc.search(companyId, companySearchQuerySchema.parse({ q: "TST-42" }));

    expect(result.results[0]?.id).toBe(exactId);
    expect(result.results[0]?.matchedFields).toContain("identifier");
  });

  it("ranks phrase before reordered title words and rejects partial matches", async () => {
    const companyId = await createCompany();
    const base = new Date("2026-01-01T00:00:00.000Z").getTime();
    const partialTokenId = await createIssue(companyId, {
      identifier: "TST-50",
      title: "Alpha-only deployment",
      updatedAt: new Date(base + 3_000),
    });
    const allTokenId = await createIssue(companyId, {
      identifier: "TST-51",
      title: "Alpha rollout beta",
      updatedAt: new Date(base + 2_000),
    });
    const phraseId = await createIssue(companyId, {
      identifier: "TST-52",
      title: "Alpha beta deployment",
      updatedAt: new Date(base + 1_000),
    });

    const result = await svc.search(companyId, companySearchQuerySchema.parse({ q: "alpha beta", scope: "issues" }));

    expect(result.results.map((row) => row.id)).toEqual([phraseId, allTokenId]);
    expect(result.results.map((row) => row.id)).not.toContain(partialTokenId);
  });

  it("matches multiple tokens across the same issue thread and returns comment snippets", async () => {
    const companyId = await createCompany();
    const issueId = await createIssue(companyId, {
      identifier: "TST-7",
      title: "Checkout semantics",
      description: "Atomic ownership is enforced here.",
    });
    const commentId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      body: "The ranking snippet should explain why this thread matched.",
    });

    const result = await svc.search(companyId, companySearchQuerySchema.parse({ q: "checkout snippet" }));
    const match = result.results.find((item) => item.id === issueId);

    expect(match).toBeTruthy();
    expect(match?.matchedFields).toEqual(expect.arrayContaining(["title", "comment"]));
    expect(match?.href).toContain(`#comment-${commentId}`);
    expect(match?.snippets.some((snippet) => snippet.field === "comment" && /snippet/i.test(snippet.text))).toBe(true);
    expect(match?.snippets.find((snippet) => snippet.field === "comment")?.highlights.length).toBeGreaterThan(0);
    expect(result.countsByType.comment).toBe(1);
  });

  it("searches issue documents and returns document metadata for snippets", async () => {
    const companyId = await createCompany();
    const issueId = await createIssue(companyId, {
      identifier: "TST-8",
      title: "Adapter manager",
    });
    const documentId = randomUUID();
    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Hermes Parser Plan",
      latestBody: "The external adapter parser should be discovered from the plugin package.",
      format: "markdown",
    });
    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId,
      key: "plan",
    });

    const result = await svc.search(companyId, companySearchQuerySchema.parse({ q: "Hermes parser", scope: "documents" }));

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.id).toBe(issueId);
    expect(result.results[0]?.matchedFields).toContain("document");
    expect(result.results[0]?.href).toContain("#document-plan");
    expect(result.results[0]?.snippet).toMatch(/parser/i);
    expect(result.results[0]?.snippets[0]).toMatchObject({ field: "document", label: "Hermes Parser Plan" });
    expect(result.results[0]?.snippets[0]?.highlights.length).toBeGreaterThan(0);
    expect(result.countsByType.document).toBe(1);
  });

  it("searches artifact projections through the artifacts scope", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, { name: "Artifact Writer" });
    const issueId = await createIssue(companyId, {
      identifier: "TST-88",
      title: "Produce artifact",
    });
    const documentId = randomUUID();
    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Launch Artifact Brief",
      latestBody: "The searchable artifact body mentions a comet-tail preview.",
      format: "markdown",
      createdByAgentId: agentId,
    });
    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId,
      key: "brief",
    });

    const result = await svc.search(companyId, companySearchQuerySchema.parse({ q: "comet-tail", scope: "artifacts" }));

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      type: "artifact",
      title: "Launch Artifact Brief",
      href: expect.stringContaining("#document-brief"),
      artifact: expect.objectContaining({
        mediaKind: "document",
        issueIdentifier: "TST-88",
      }),
    });
    expect(result.results[0]?.snippet).toMatch(/comet tail/i);
    expect(result.countsByType).toEqual({ issue: 0, comment: 0, document: 0, artifact: 1, file: 0, record: 0, agent: 0, project: 0 });
  });

  it("does not pass high-offset search fetch windows through to artifact query validation", async () => {
    const companyId = await createCompany();

    const result = await svc.search(companyId, companySearchQuerySchema.parse({
      q: "artifact",
      scope: "artifacts",
      limit: "50",
      offset: "75",
    }));

    expect(result.results).toEqual([]);
    expect(result.countsByType.artifact).toBe(0);
  });

  it("applies issue filters before sorting and pagination", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, { name: "Needle engineer" });
    const projectId = await createProject(companyId, { name: "Needle project" });
    const labelId = await createLabel(companyId, { name: "Needle label" });
    const base = new Date("2026-01-01T00:00:00.000Z").getTime();
    const newestMatch = await createIssue(companyId, {
      identifier: "TST-30",
      title: "Needle newest",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      projectId,
      updatedAt: new Date(base + 3_000),
    });
    const olderMatch = await createIssue(companyId, {
      identifier: "TST-31",
      title: "Needle older",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      projectId,
      updatedAt: new Date(base + 2_000),
    });
    const statusDecoy = await createIssue(companyId, {
      identifier: "TST-32",
      title: "Needle done",
      status: "done",
      priority: "high",
      assigneeAgentId: agentId,
      projectId,
      updatedAt: new Date(base + 4_000),
    });
    await db.insert(issueLabels).values([
      { companyId, issueId: newestMatch, labelId },
      { companyId, issueId: olderMatch, labelId },
      { companyId, issueId: statusDecoy, labelId },
    ]);

    const result = await svc.search(companyId, companySearchQuerySchema.parse({
      q: "needle",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      projectId,
      labelId,
      updatedAfter: new Date(base + 1_000).toISOString(),
      sort: "updated",
      limit: "1",
      offset: "1",
    }));

    expect(result.results.map((row) => row.id)).toEqual([olderMatch]);
    expect(result.countsByType.issue).toBe(2);
    expect(result.countsByType.agent).toBe(0);
    expect(result.countsByType.project).toBe(0);
    expect(result.filterOptionCounts.status.todo).toBe(2);
    expect(result.filterOptionCounts.status.done).toBe(1);
    expect(result.hasMore).toBe(false);
  });

  it("returns issue rows for filter-only searches", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, { name: "Filter owner" });
    const matchingIssue = await createIssue(companyId, {
      identifier: "TST-34",
      title: "Filtered task",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await createIssue(companyId, {
      identifier: "TST-35",
      title: "Filtered decoy",
      status: "done",
      assigneeAgentId: agentId,
    });
    await createAgent(companyId, { name: "Todo" });
    await createProject(companyId, { name: "Todo" });

    const result = await svc.search(companyId, companySearchQuerySchema.parse({
      q: "",
      status: "todo",
      assigneeAgentId: agentId,
    }));

    expect(result.results.map((row) => row.id)).toEqual([matchingIssue]);
    expect(result.countsByType.issue).toBe(1);
    expect(result.countsByType.agent).toBe(0);
    expect(result.countsByType.project).toBe(0);
    expect(result.results[0]?.snippets).toEqual([]);
  });

  it("returns zero-result loosen data and suppresses agent/project rows while issue filters are active", async () => {
    const companyId = await createCompany();
    await createAgent(companyId, { name: "Needle agent", capabilities: "Needle capabilities" });
    await createProject(companyId, { name: "Needle project", description: "Needle roadmap" });

    const result = await svc.search(companyId, companySearchQuerySchema.parse({ q: "needle", status: "todo" }));

    expect(result.results).toEqual([]);
    expect(result.countsByType.agent).toBe(0);
    expect(result.countsByType.project).toBe(0);
    expect(result.zeroResults).toMatchObject({
      unfilteredTotal: 2,
      loosenSuggestions: [
        { filter: "status", values: ["todo"], resultCount: 2, additionalCount: 2 },
      ],
    });
  });

  it("does not leak hidden issue-backed artifacts", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, { name: "Artifact Writer" });
    const visibleIssueId = await createIssue(companyId, {
      identifier: "TST-33",
      title: "Visible artifact holder",
    });
    const hiddenIssueId = await createIssue(companyId, {
      identifier: "TST-34",
      title: "Hidden artifact holder",
      hiddenAt: new Date(),
    });
    const visibleDocumentId = randomUUID();
    const hiddenDocumentId = randomUUID();
    await db.insert(documents).values([
      {
        id: visibleDocumentId,
        companyId,
        title: "Visible Artifact",
        latestBody: "Searchable artifact body",
        format: "markdown",
        createdByAgentId: agentId,
      },
      {
        id: hiddenDocumentId,
        companyId,
        title: "Hidden Artifact",
        latestBody: "Searchable artifact body",
        format: "markdown",
        createdByAgentId: agentId,
      },
    ]);
    await db.insert(issueDocuments).values([
      { companyId, issueId: visibleIssueId, documentId: visibleDocumentId, key: "visible" },
      { companyId, issueId: hiddenIssueId, documentId: hiddenDocumentId, key: "hidden" },
    ]);

    const result = await svc.search(companyId, companySearchQuerySchema.parse({ q: "artifact", scope: "artifacts" }));

    expect(result.results.map((row) => row.artifact?.issueId)).toEqual([visibleIssueId]);
    expect(result.countsByType.artifact).toBe(1);
  });

  it("excludes hidden issues and other companies' data", async () => {
    const companyId = await createCompany("Visible Co");
    const otherCompanyId = await createCompany("Other Co");
    const visibleId = await createIssue(companyId, {
      identifier: "VIS-1",
      title: "Visible needle",
    });
    await createIssue(companyId, {
      identifier: "HID-1",
      title: "Hidden needle",
      hiddenAt: new Date(),
    });
    await createIssue(companyId, {
      identifier: "HAR-1",
      title: "Harness needle",
      harnessKind: "skill_test",
    });
    await createIssue(otherCompanyId, {
      identifier: "OTH-1",
      title: "Other company needle",
    });

    const result = await svc.search(companyId, companySearchQuerySchema.parse({ q: "needle" }));

    expect(result.results.map((item) => item.id)).toEqual([visibleId]);
  });

  it("treats bare SQL wildcard characters as literals instead of match-all queries", async () => {
    const companyId = await createCompany();
    const issueId = await createIssue(companyId, {
      identifier: "TST-20",
      title: "Plain issue target",
      description: "Plain issue description",
    });
    await db.insert(issueComments).values({
      companyId,
      issueId,
      body: "Plain comment body",
    });
    const documentId = randomUUID();
    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Plain document",
      latestBody: "Plain document body",
      format: "markdown",
    });
    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId,
      key: "plain",
    });
    await createAgent(companyId, {
      name: "Plain Agent",
      role: "engineer",
      capabilities: "Plain agent capabilities",
    });
    await createProject(companyId, {
      name: "Plain Project",
      description: "Plain project description",
    });

    for (const q of ["%", "_", "\\"]) {
      const result = await svc.search(companyId, companySearchQuerySchema.parse({ q }));
      expect(result.results, `q=${q}`).toEqual([]);
    }
  });

  it("matches percent characters literally across issue, comment, document, agent, and project results", async () => {
    const companyId = await createCompany();
    const issueMatchId = await createIssue(companyId, {
      identifier: "TST-21",
      title: "Release 100% checklist",
    });
    const issueDecoyId = await createIssue(companyId, {
      identifier: "TST-22",
      title: "Release 1000 checklist",
    });
    const commentMatchId = await createIssue(companyId, {
      identifier: "TST-23",
      title: "Comment literal holder",
    });
    const commentDecoyId = await createIssue(companyId, {
      identifier: "TST-24",
      title: "Comment decoy holder",
    });
    await db.insert(issueComments).values([
      {
        companyId,
        issueId: commentMatchId,
        body: "QA is 100% confident in this result.",
      },
      {
        companyId,
        issueId: commentDecoyId,
        body: "QA is 1000 confident in this result.",
      },
    ]);
    const documentMatchIssueId = await createIssue(companyId, {
      identifier: "TST-25",
      title: "Document literal holder",
    });
    const documentDecoyIssueId = await createIssue(companyId, {
      identifier: "TST-26",
      title: "Document decoy holder",
    });
    const documentMatchId = randomUUID();
    const documentDecoyId = randomUUID();
    await db.insert(documents).values([
      {
        id: documentMatchId,
        companyId,
        title: "Literal rollout",
        latestBody: "Ship 100% complete adapter support.",
        format: "markdown",
      },
      {
        id: documentDecoyId,
        companyId,
        title: "Decoy rollout",
        latestBody: "Ship 1000 complete adapter support.",
        format: "markdown",
      },
    ]);
    await db.insert(issueDocuments).values([
      {
        companyId,
        issueId: documentMatchIssueId,
        documentId: documentMatchId,
        key: "literal",
      },
      {
        companyId,
        issueId: documentDecoyIssueId,
        documentId: documentDecoyId,
        key: "decoy",
      },
    ]);
    const agentMatchId = await createAgent(companyId, {
      name: "100% Specialist",
      role: "engineer",
    });
    const agentDecoyId = await createAgent(companyId, {
      name: "1000 Specialist",
      role: "engineer",
    });
    const projectMatchId = await createProject(companyId, {
      name: "100% Launch Plan",
    });
    const projectDecoyId = await createProject(companyId, {
      name: "1000 Launch Plan",
    });

    const result = await svc.search(companyId, companySearchQuerySchema.parse({ q: "100%" }));
    const ids = result.results.map((row) => row.id);

    expect(ids).toEqual(expect.arrayContaining([
      issueMatchId,
      commentMatchId,
      documentMatchIssueId,
      agentMatchId,
      projectMatchId,
    ]));
    expect(ids).not.toEqual(expect.arrayContaining([
      issueDecoyId,
      commentDecoyId,
      documentDecoyIssueId,
      agentDecoyId,
      projectDecoyId,
    ]));
  });

  it("applies offset after merging cross-type result ranking", async () => {
    const companyId = await createCompany();
    const base = new Date("2026-01-01T00:00:00.000Z").getTime();
    const agentIds = await Promise.all([
      createAgent(companyId, { name: "Needle agent 1", updatedAt: new Date(base + 6_000) }),
      createAgent(companyId, { name: "Needle agent 2", updatedAt: new Date(base + 5_000) }),
      createAgent(companyId, { name: "Needle agent 3", updatedAt: new Date(base + 4_000) }),
    ]);
    const projectIds = await Promise.all([
      createProject(companyId, { name: "Needle project 1", updatedAt: new Date(base + 3_000) }),
      createProject(companyId, { name: "Needle project 2", updatedAt: new Date(base + 2_000) }),
      createProject(companyId, { name: "Needle project 3", updatedAt: new Date(base + 1_000) }),
    ]);

    const result = await svc.search(companyId, companySearchQuerySchema.parse({ q: "needle", limit: "2", offset: "2" }));

    expect(result.results.map((row) => row.id)).toEqual([agentIds[2], projectIds[0]]);
    expect(result.countsByType).toEqual({ issue: 0, comment: 0, document: 0, artifact: 0, file: 0, record: 0, agent: 3, project: 3 });
    expect(result.hasMore).toBe(true);
  });

  it("escapes underscore and backslash characters in issue phrase and token patterns", async () => {
    const companyId = await createCompany();
    const literalId = await createIssue(companyId, {
      identifier: "TST-27",
      title: "Literal foo_bar path c:\\tmp",
    });
    const decoyId = await createIssue(companyId, {
      identifier: "TST-28",
      title: "Decoy fooXbar path c:tmp",
    });

    for (const q of ["foo_bar", "c:\\tmp"]) {
      const result = await svc.search(companyId, companySearchQuerySchema.parse({ q, scope: "issues" }));
      const ids = result.results.map((row) => row.id);
      expect(ids, `q=${q}`).toContain(literalId);
      expect(ids, `q=${q}`).not.toContain(decoyId);
    }
  });

  it("does not interpret short UI terms as the middle of unrelated words", async () => {
    const companyId = await createCompany();
    const target = await createIssue(companyId, { title: "Improve mobile UI" });
    await createIssue(companyId, { title: "Build billing reports" });
    const result = await svc.search(companyId, companySearchQuerySchema.parse({ q: "UI" }));
    expect(result.results.map((row) => row.id)).toEqual([target]);
  });

  it("keeps typo fallback inside the requested filters", async () => {
    const companyId = await createCompany();
    await createIssue(companyId, { title: "Mibile API", status: "done" });
    const target = await createIssue(companyId, { title: "Mobile API", status: "todo" });
    const result = await svc.search(companyId, companySearchQuerySchema.parse({ q: "mibile api", status: "todo" }));
    expect(result.results.map((row) => row.id)).toEqual([target]);
  });

  it("keeps exact title hits on the task and chooses the most complete context evidence", async () => {
    const companyId = await createCompany();
    const task = await createIssue(companyId, { title: "Aurora callback" });
    await db.insert(issueComments).values({ companyId, issueId: task, body: "Aurora callback is mentioned here too." });
    const exact = await svc.search(companyId, companySearchQuerySchema.parse({ q: "Aurora callback" }));
    expect(exact.results[0]?.href).not.toContain("#comment-");

    const holder = await createIssue(companyId, { title: "Connection investigation" });
    await db.insert(issueComments).values({ companyId, issueId: holder, body: "Aurora was discussed.", updatedAt: new Date("2026-06-01") });
    const strongest = randomUUID();
    await db.insert(issueComments).values({ id: strongest, companyId, issueId: holder,
      body: "Aurora loses the callback state.", updatedAt: new Date("2026-01-01") });
    const result = await svc.search(companyId, companySearchQuerySchema.parse({ q: "aurora state callback" }));
    expect(result.results[0]?.href).toContain(`#comment-${strongest}`);
    expect(result.results[0]?.snippet).toContain("state");
  });

  it.each(["comment", "document"] as const)("preserves %s evidence when title and identifier both match", async (source) => {
    const companyId = await createCompany();
    const task = await createIssue(companyId, {
      identifier: "CTX-123", title: "CTX callback investigation", description: "CTX callback details",
    });
    const sourceId = randomUUID();
    if (source === "comment") {
      await db.insert(issueComments).values({ id: sourceId, companyId, issueId: task, body: "The missing signal is quasar." });
    } else {
      await db.insert(documents).values({ id: sourceId, companyId, title: "Investigation plan", latestBody: "The missing signal is quasar.", format: "markdown" });
      await db.insert(issueDocuments).values({ companyId, issueId: task, documentId: sourceId, key: "plan" });
    }

    const result = await svc.search(companyId, companySearchQuerySchema.parse({ q: "CTX quasar" }));
    const match = result.results.find((row) => row.id === task)!;
    expect(match.matchedFields).toEqual(expect.arrayContaining(["identifier", "title", source]));
    expect(match.score).toBeGreaterThanOrEqual(2000);
    expect(match.score).toBeLessThan(3000);
    expect(match.snippets).toHaveLength(2);
    expect(match.snippets[0]).toMatchObject({ field: source, text: expect.stringContaining("quasar") });
    expect(match.snippet).toContain("quasar");
    expect(match.href).toContain(source === "comment" ? `#comment-${sourceId}` : "#document-plan");
  });

  it("reflects edits, deleted comments and document updates immediately", async () => {
    const companyId = await createCompany();
    const task = await createIssue(companyId, { title: "Old uniquequartz title" });
    const find = () => svc.search(companyId, companySearchQuerySchema.parse({ q: '"uniquequartz"' }));
    expect((await find()).results.map((row) => row.id)).toEqual([task]);
    await db.update(issues).set({ title: "New title" }).where(sql`${issues.id} = ${task}`);
    expect((await find()).results).toEqual([]);
    const comment = randomUUID();
    await db.insert(issueComments).values({ id: comment, companyId, issueId: task, body: "uniquequartz" });
    expect((await find()).results.map((row) => row.id)).toEqual([task]);
    await db.update(issueComments).set({ deletedAt: new Date() }).where(sql`${issueComments.id} = ${comment}`);
    expect((await find()).results).toEqual([]);
    const doc = randomUUID();
    await db.insert(documents).values({ id: doc, companyId, title: "Findings", latestBody: "uniquequartz", format: "markdown" });
    await db.insert(issueDocuments).values({ companyId, issueId: task, documentId: doc, key: "plan" });
    expect((await find()).results.map((row) => row.id)).toEqual([task]);
    await db.update(documents).set({ latestBody: "Updated findings" }).where(sql`${documents.id} = ${doc}`);
    expect((await find()).results).toEqual([]);
  });

  it("uses pg_trgm for conservative fuzzy title matches", async () => {
    const companyId = await createCompany();
    const issueId = await createIssue(companyId, {
      identifier: "TST-9",
      title: "Onboarding wizard polish",
    });

    const result = await svc.search(companyId, companySearchQuerySchema.parse({ q: "onbordng wizard" }));

    expect(result.results[0]?.id).toBe(issueId);
    expect(result.results[0]?.matchedFields).toContain("title");
  });

  it("matches transposition typos against multi-word titles", async () => {
    const companyId = await createCompany();
    const searchIssueId = await createIssue(companyId, {
      identifier: "TST-10",
      title: "Improve search performance",
    });
    const mobileIssueId = await createIssue(companyId, {
      identifier: "TST-11",
      title: "Polish mobile navigation",
    });
    const otherIssueId = await createIssue(companyId, {
      identifier: "TST-12",
      title: "Refactor billing reports",
    });

    const transpositionCases: Array<{ query: string; expectedId: string; rejected: string }> = [
      { query: "serach", expectedId: searchIssueId, rejected: otherIssueId },
      { query: "mibile", expectedId: mobileIssueId, rejected: otherIssueId },
      { query: "mobail", expectedId: mobileIssueId, rejected: otherIssueId },
    ];

    for (const { query, expectedId, rejected } of transpositionCases) {
      const result = await svc.search(companyId, companySearchQuerySchema.parse({ q: query }));
      const ids = result.results.map((row) => row.id);
      expect(ids, `query=${query}`).toContain(expectedId);
      expect(ids, `query=${query} should not match unrelated issue`).not.toContain(rejected);
    }
  });
});
