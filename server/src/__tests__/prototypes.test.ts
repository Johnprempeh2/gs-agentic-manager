import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companySecrets,
  createDb,
  issues,
  issueWorkProducts,
  organisations,
  pipelineCaseProjectLinks,
  pipelineCases,
  pipelines,
  pipelineStages,
  projects,
  prototypePortalShares,
  websiteSite,
} from "@greatstone/db";
import type { PortalPrototypesPayload } from "@greatstone/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { deliverableRoutes } from "../routes/deliverables.js";
import type { StorageService } from "../storage/types.js";

// Prototypes (John, 14 Nov): registering never shares; only a person shows a
// prototype to its client, the portal push carries only that client's shared
// prototypes, and turning it off pushes a list without it at once.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const companyId = "11111111-1111-4111-8111-111111111111";
const agentId = "33333333-3333-4333-8333-333333333333";
const projectA = "55555555-5555-4555-8555-555555555555";
const projectB = "56555555-5555-4555-8555-555555555555";
const issueA = "66666666-6666-4666-8666-666666666666";
const issueB = "67666666-6666-4666-8666-666666666666";
const orgA = "77777777-7777-4777-8777-777777777777";
const orgB = "78777777-7777-4777-8777-777777777777";
const websiteA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const websiteB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const storage = {
  provider: "local_disk",
  putFile: vi.fn(),
  getObject: vi.fn(async () => ({ stream: Readable.from(Buffer.from("")), contentType: "image/jpeg", contentLength: 0 })),
  headObject: vi.fn(),
  deleteObject: vi.fn(),
} as unknown as StorageService;

describeEmbeddedPostgres("prototypes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const pushed: PortalPrototypesPayload[] = [];
  const prototypePush = vi.fn(async (_site: unknown, payload: PortalPrototypesPayload) => { pushed.push(payload); });

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-prototypes-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    pushed.length = 0;
    prototypePush.mockClear();
    await db.delete(activityLog);
    await db.delete(prototypePortalShares);
    await db.delete(issueWorkProducts);
    await db.delete(pipelineCaseProjectLinks);
    await db.delete(pipelineCases);
    await db.delete(pipelineStages);
    await db.delete(pipelines);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(organisations);
    await db.delete(websiteSite);
    await db.delete(companySecrets);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    await db.insert(companies).values({ id: companyId, name: "Greatstone", issuePrefix: "GRE", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Lintel", role: "engineer" });
    await db.insert(organisations).values([
      { id: orgA, companyId, name: "Northwind Test", status: "client", websiteOrganisationId: websiteA },
      { id: orgB, companyId, name: "Contoso Test", status: "client", websiteOrganisationId: websiteB },
    ]);
    await db.insert(projects).values([
      { id: projectA, companyId, name: "Northwind portal", status: "in_progress" },
      { id: projectB, companyId, name: "Contoso app", status: "in_progress" },
    ]);
    await db.insert(issues).values([
      { id: issueA, companyId, projectId: projectA, identifier: "GRE-1", title: "Build it", status: "in_progress", priority: "medium", assigneeAgentId: agentId },
      { id: issueB, companyId, projectId: projectB, identifier: "GRE-2", title: "Build that", status: "in_progress", priority: "medium", assigneeAgentId: agentId },
    ]);
    const [pipeline] = await db.insert(pipelines).values({ companyId, key: "clients", name: "Clients" }).returning();
    const [stage] = await db.insert(pipelineStages).values({ pipelineId: pipeline!.id, key: "active", name: "Active", kind: "working", position: 0 }).returning();
    const cases = await db.insert(pipelineCases).values([
      { companyId, pipelineId: pipeline!.id, stageId: stage!.id, caseKey: "a", title: "Northwind engagement", organisationId: orgA },
      { companyId, pipelineId: pipeline!.id, stageId: stage!.id, caseKey: "b", title: "Contoso engagement", organisationId: orgB },
    ]).returning();
    await db.insert(pipelineCaseProjectLinks).values([
      { companyId, caseId: cases[0]!.id, projectId: projectA },
      { companyId, caseId: cases[1]!.id, projectId: projectB },
    ]);
    const [secret] = await db.insert(companySecrets).values({ companyId, key: "bridge-write", name: "Bridge write" }).returning();
    await db.insert(websiteSite).values({ companyId, name: "Site", domain: "site.example.invalid", netlifySiteId: "test-site", dataBridgeWriteSecretId: secret!.id });
  }

  function appAs(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", deliverableRoutes(db, storage, { screenshot: async () => null, prototypePush }));
    app.use(errorHandler);
    return app;
  }
  const board = () => appAs({
    type: "board", userId: "user-1", source: "local_implicit", isInstanceAdmin: true, companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner", status: "active" }],
  } as Express.Request["actor"]);
  const agent = () => appAs({ type: "agent", agentId, companyId, source: "agent_key" } as Express.Request["actor"]);

  async function register(issueId: string, url: string, title = "Discovery portal") {
    const res = await request(agent()).post(`/api/issues/${issueId}/deliverables`).send({ url, title, kind: "prototype", summary: "Clickable first cut" });
    expect(res.status).toBe(201);
    return res.body as { id: string };
  }
  const list = async (query = "") => (await request(board()).get(`/api/companies/${companyId}/prototypes${query}`)).body.prototypes as Array<{
    id: string; prototypeStatus: string; client: { id: string; name: string } | null; portal: { visible: boolean; needsReshare: boolean }; owner: { name: string } | null;
  }>;
  const share = (actorApp: express.Express, id: string, visible: boolean, organisationId = orgA) =>
    request(actorApp).post(`/api/companies/${companyId}/prototypes/${id}/visibility`).send({ visible, organisationId });
  const lastPushFor = (customerId: string) => [...pushed].reverse().find((payload) => payload.customerId === customerId);

  it("registers as Internal, lists by client with owner and status, and an agent can never share", async () => {
    await seed();
    const a = await register(issueA, "https://northwind-proto.example.invalid");
    await register(issueB, "https://contoso-proto.example.invalid", "Contoso app");

    const all = await list();
    expect(all).toHaveLength(2);
    const mine = all.find((item) => item.id === a.id)!;
    expect(mine).toMatchObject({ prototypeStatus: "draft", client: { id: orgA, name: "Northwind Test" }, portal: { visible: false }, owner: { name: "Lintel" } });
    expect((await list(`?organisationId=${orgB}`)).map((item) => item.client?.name)).toEqual(["Contoso Test"]);
    expect(prototypePush).not.toHaveBeenCalled();

    // Rule: agents may never set visibility.
    const refused = await share(agent(), a.id, true);
    expect(refused.status).toBe(403);
    expect(await db.select().from(prototypePortalShares)).toHaveLength(0);
    expect(prototypePush).not.toHaveBeenCalled();
  });

  it("shares with the confirmed client only, logs it, and unsharing pushes a list without it", async () => {
    await seed();
    const a = await register(issueA, "https://northwind-proto.example.invalid");
    const b = await register(issueB, "https://contoso-proto.example.invalid", "Contoso app");

    // A confirm naming another client is refused.
    expect((await share(board(), a.id, true, orgB)).status).toBe(422);

    const shared = await share(board(), a.id, true);
    expect(shared.status).toBe(200);
    expect(shared.body).toMatchObject({ prototype: { prototypeStatus: "shared", portal: { visible: true } }, portal: { sites: 1, error: null } });
    expect(lastPushFor(websiteA)!.prototypes.map((item) => item.url)).toEqual(["https://northwind-proto.example.invalid"]);
    expect(lastPushFor(websiteA)!.prototypes[0]).toMatchObject({ title: "Discovery portal", description: "Clickable first cut" });
    // Rule: another client's push never carries it.
    expect((await share(board(), b.id, false, orgB)).status).toBe(200);
    expect(lastPushFor(websiteB)!.prototypes).toEqual([]);

    const [logged] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.prototype_shared")));
    expect(logged).toMatchObject({ actorType: "user", entityId: issueA });
    expect(logged!.details).toMatchObject({ clientName: "Northwind Test", organisationId: orgA });

    // Rule: unsharing removes it from the portal at once.
    const off = await share(board(), a.id, false);
    expect(off.status).toBe(200);
    expect(off.body.prototype.portal.visible).toBe(false);
    expect(lastPushFor(websiteA)!.prototypes).toEqual([]);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.prototype_unshared"))).toHaveLength(1);
  });

  it("hides a shared prototype when it moves to another client, gets a new address or is retired", async () => {
    await seed();
    const a = await register(issueA, "https://northwind-proto.example.invalid");
    await share(board(), a.id, true);

    // A new version at another address leaves the portal until a person shares it again.
    const v2 = await register(issueA, "https://northwind-proto-v2.example.invalid");
    await vi.waitFor(() => expect(lastPushFor(websiteA)!.prototypes).toEqual([]));
    expect((await list()).find((item) => item.id === v2.id)!.portal).toMatchObject({ visible: false, needsReshare: true });
    expect((await share(board(), v2.id, true)).body.portal.sites).toBe(1);
    expect(lastPushFor(websiteA)!.prototypes.map((item) => item.version)).toEqual([2]);

    // Moving it under another client's project hides it from the first client.
    pushed.length = 0;
    expect((await request(board()).post(`/api/companies/${companyId}/deliverables/${v2.id}/move`).send({ projectId: projectB })).status).toBe(200);
    await vi.waitFor(() => expect(lastPushFor(websiteA)!.prototypes).toEqual([]));

    // Retiring removes the share and pushes.
    await request(board()).post(`/api/companies/${companyId}/deliverables/${v2.id}/move`).send({ projectId: projectA });
    await share(board(), v2.id, true);
    const retired = await request(board()).patch(`/api/companies/${companyId}/prototypes/${v2.id}/status`).send({ status: "retired" });
    expect(retired.status).toBe(200);
    expect(retired.body.prototype.prototypeStatus).toBe("retired");
    expect(lastPushFor(websiteA)!.prototypes).toEqual([]);
    expect(await db.select().from(prototypePortalShares)).toHaveLength(0);
    expect((await share(board(), v2.id, true)).status).toBe(422);
  });
});
