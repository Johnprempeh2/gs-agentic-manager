import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, companyMemberships, createDb, crmSyncBindings, crmSyncRecordLinks, issues, organisations, pipelineCaseIssueLinks, pipelineCases, pipelines, toolApplications, toolConnections, websiteModule, websiteSite } from "@greatstone/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { websiteEnquiryService, type WebsiteEnquiry, type WebsiteEnquiryReader } from "../services/website/enquiries.js";
import { pipedriveWebsiteOriginId, websiteEnquiryPipedriveCopy } from "../services/website/enquiry-pipedrive.js";
import type { PipedriveClient } from "../services/crm-sync-pipedrive.js";

const embedded = await getEmbeddedPostgresTestSupport();
const describeDb = embedded.supported ? describe.sequential : describe.skip;

describeDb("website enquiries", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-website-enquiries-");
    db = createDb(tempDb.connectionString);
  });
  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(pipelineCaseIssueLinks);
    await db.delete(issues);
    await db.delete(crmSyncRecordLinks);
    await db.delete(crmSyncBindings);
    await db.delete(pipelines);
    await db.delete(organisations);
    await db.delete(websiteModule);
    await db.delete(websiteSite);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });
  afterAll(async () => { await tempDb?.cleanup(); });

  async function company() {
    const [row] = await db.insert(companies).values({
      name: "Greatstone",
      issuePrefix: `W${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`,
    }).returning();
    return row!.id;
  }

  function enquiry(id: string, email = "jo@acme.test"): WebsiteEnquiry {
    return {
      id, name: "Jo Example", email, source: "contact-form", page: "/contact",
      utm: { source: "newsletter" }, consent: { followUp: true },
      createdAt: "2026-10-24T12:00:00Z",
    };
  }

  it("imports once on the site's enquiry id and retains source, page, UTM and consent", async () => {
    const companyId = await company();
    const siteId = randomUUID();
    const service = websiteEnquiryService(db);
    const reader: WebsiteEnquiryReader = {
      listEnquiries: async (_siteId, cursor) => cursor
        ? { items: [enquiry("e-2", "sam@second.test")] }
        : { items: [enquiry("e-1")], nextCursor: "page-2" },
    };
    expect(await service.importFromBridge(companyId, siteId, reader)).toEqual({ created: 2, skipped: 0 });
    expect(await service.importFromBridge(companyId, siteId, reader)).toEqual({ created: 0, skipped: 2 });
    const rows = await service.list(companyId, siteId);
    expect(rows).toHaveLength(2);
    const first = rows.find((row) => row.fields.websiteEnquiryId === "e-1")!;
    expect(first.fields).toMatchObject({
      source: "contact-form", page: "/contact", utm: { source: "newsletter" },
      consent: { followUp: true },
    });
    expect(await db.select().from(pipelineCases).where(eq(pipelineCases.companyId, companyId))).toHaveLength(2);
  });

  it("matches a live organisation by email domain in the same company", async () => {
    const companyId = await company();
    const anotherCompanyId = await company();
    const [wrong] = await db.insert(organisations).values({ companyId: anotherCompanyId, name: "Wrong", domain: "acme.test" }).returning();
    const [matched] = await db.insert(organisations).values({ companyId, name: "Acme", domain: "ACME.TEST" }).returning();
    const result = await websiteEnquiryService(db).importOne(companyId, randomUUID(), enquiry("e-3"));
    const [row] = await db.select().from(pipelineCases).where(and(
      eq(pipelineCases.companyId, companyId), eq(pipelineCases.id, result.caseId),
    ));
    expect(row!.organisationId).toBe(matched!.id);
    expect(row!.organisationId).not.toBe(wrong!.id);
    expect(await db.select().from(organisations).where(eq(organisations.companyId, companyId))).toHaveLength(1);
  });

  it("does not group unrelated personal email addresses into one organisation", async () => {
    const companyId = await company();
    const siteId = randomUUID();
    const service = websiteEnquiryService(db);
    await service.importOne(companyId, siteId, enquiry("e-4", "one@gmail.com"));
    await service.importOne(companyId, siteId, enquiry("e-5", "two@gmail.com"));
    expect(await db.select().from(organisations).where(eq(organisations.companyId, companyId))).toHaveLength(2);
  });

  it("files one GSAM inbox task linked to the lead when the site exists", async () => {
    const companyId = await company();
    const ownerUserId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: ownerUserId, status: "active", membershipRole: "operator",
    });
    const [site] = await db.insert(websiteSite).values({
      companyId, name: "Greatstone", domain: "greatstone.test", netlifySiteId: "staging",
    }).returning();
    await db.insert(websiteModule).values({
      companyId, siteId: site!.id, key: "front-door", name: "Front door and enquiries", ownerUserId,
    });
    const service = websiteEnquiryService(db);
    const first = await service.importOne(companyId, site!.id, enquiry("e-8"));
    const repeat = await service.importOne(companyId, site!.id, enquiry("e-8"));
    expect(first.created).toBe(true);
    expect(repeat).toEqual({ caseId: first.caseId, created: false });
    const inbox = await db.select().from(issues).where(eq(issues.companyId, companyId));
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ status: "todo", assigneeUserId: ownerUserId, originKind: "website_enquiry", originId: first.caseId });
    expect(await db.select().from(pipelineCaseIssueLinks).where(eq(pipelineCaseIssueLinks.caseId, first.caseId))).toHaveLength(1);
  });

  async function pipedriveConnection(companyId: string, pipelineId: string) {
    const [application] = await db.insert(toolApplications).values({
      companyId, applicationKey: `pipedrive-${randomUUID()}`, name: "Pipedrive", type: "mcp_http", status: "active",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId, applicationId: application!.id, name: "Pipedrive", uid: randomUUID(),
      transport: "rest_api", authKind: "api_key", status: "active", enabled: true,
    }).returning();
    await db.insert(crmSyncBindings).values({
      companyId, connectionId: connection!.id, providerKey: "pipedrive", containerKind: "crm_pipeline",
      externalContainerId: "1", pipelineId,
    });
  }

  it("copies a website lead to Pipedrive once across repeat runs", async () => {
    const companyId = await company();
    const siteId = randomUUID();
    const service = websiteEnquiryService(db);
    const item = enquiry("e-6");
    const imported = await service.importOne(companyId, siteId, item);
    const [caseRow] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, imported.caseId));
    await pipedriveConnection(companyId, caseRow!.pipelineId);
    let createdPeople = 0;
    let createdLeads = 0;
    const fakeClient = {
      listLeadsPage: async () => ({ items: [], nextStart: null }),
      listArchivedLeadsPage: async () => ({ items: [], nextStart: null }),
      listPersonsPage: async () => ({ items: [{ id: 42, email: [{ value: item.email }] }], nextStart: null }),
      createPerson: async () => { createdPeople += 1; return { id: 43 }; },
      createLead: async ({ originId }: { originId: string }) => {
        expect(originId).toBe(pipedriveWebsiteOriginId(siteId, item.id));
        createdLeads += 1;
        return { id: "pd-lead-1" };
      },
    } as unknown as PipedriveClient;
    const copy = websiteEnquiryPipedriveCopy(db, { clientForConnection: async () => fakeClient });
    expect(await copy({ companyId, siteId, caseId: imported.caseId, enquiry: item })).toEqual({ externalId: "pd-lead-1", created: true });
    expect(await copy({ companyId, siteId, caseId: imported.caseId, enquiry: item })).toEqual({ externalId: "pd-lead-1", created: false });
    expect(createdPeople).toBe(0);
    expect(createdLeads).toBe(1);
    expect(await db.select().from(crmSyncRecordLinks)).toHaveLength(1);
  });

  it("recovers a Pipedrive lead created before its local link was saved", async () => {
    const companyId = await company();
    const siteId = randomUUID();
    const item = enquiry("e-7");
    const imported = await websiteEnquiryService(db).importOne(companyId, siteId, item);
    const [caseRow] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, imported.caseId));
    await pipedriveConnection(companyId, caseRow!.pipelineId);
    let createdLeads = 0;
    const fakeClient = {
      listLeadsPage: async () => ({ items: [{ id: "already-there", origin_id: pipedriveWebsiteOriginId(siteId, item.id) }], nextStart: null }),
      listArchivedLeadsPage: async () => ({ items: [], nextStart: null }),
      listPersonsPage: async () => ({ items: [], nextStart: null }),
      createPerson: async () => ({ id: 43 }),
      createLead: async () => { createdLeads += 1; return { id: "duplicate" }; },
    } as unknown as PipedriveClient;
    const copy = websiteEnquiryPipedriveCopy(db, { clientForConnection: async () => fakeClient });
    expect(await copy({ companyId, siteId, caseId: imported.caseId, enquiry: item })).toEqual({ externalId: "already-there", created: false });
    expect(createdLeads).toBe(0);
  });
});
