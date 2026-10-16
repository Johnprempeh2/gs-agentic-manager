import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, createDb, instanceSettings, issues, organisations } from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { organisationRoutes } from "../routes/organisations.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { groupNotionPages, mergeNotes, parseNotionPage, stageFromNotion } from "../services/organisation-import-notion.js";

const KENTE = `# Kente Logistics

Status: Active client
Website: https://kente.example.com
Country: Ghana

Fleet audit for 40 trucks. Main contact is Ama.

- [ ] Send the revised proposal
- [x] Book the kick-off
- [ ] Ask for the fuel data
`;

const KENTE_MEETING = `# Meeting 14 Oct

Ama wants weekly reports.

- [ ] Draft the weekly report template
`;

const PAGES = [
  { path: "Clients 0123456789abcdef0123456789abcdef.md", markdown: "# Clients\n\n[Kente Logistics](Clients/Kente%20Logistics.md)\n" },
  { path: "Clients/Kente Logistics aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.md", markdown: KENTE },
  { path: "Clients/Kente Logistics aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Meeting 14 Oct bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.md", markdown: KENTE_MEETING },
  { path: "Clients/Osei Farms cccccccccccccccccccccccccccccccc.md", markdown: "# Osei Farms\n\nStage: Proposal sent\n\nInterested in irrigation planning." },
  { path: "Clients/Clients.csv", markdown: "Name,Status" },
];

describe("Notion page parsing", () => {
  it("reads the title, properties, body and unticked to-dos", () => {
    const page = parseNotionPage(PAGES[1]!.path, KENTE);
    expect(page).toMatchObject({
      title: "Kente Logistics",
      notionId: "a".repeat(32),
      properties: { status: "Active client", website: "https://kente.example.com", country: "Ghana" },
      todos: ["Send the revised proposal", "Ask for the fuel data"],
    });
    expect(page.body).toContain("Fleet audit for 40 trucks.");
    expect(page.body).not.toContain("Status:");
  });

  it("groups sub-pages into their client and skips index pages and other files", () => {
    const { clients, skipped } = groupNotionPages(PAGES);
    expect(clients.map((client) => client.name)).toEqual(["Kente Logistics", "Osei Farms"]);
    expect(clients[0]!.notes).toContain("## Meeting 14 Oct");
    expect(clients[0]!.todos).toEqual(["Send the revised proposal", "Ask for the fuel data", "Draft the weekly report template"]);
    expect(clients[1]!.status).toBe("prospect");
    expect(skipped.map((item) => item.reason).sort()).toEqual(["Not a Markdown page", "Only links to other pages"]);
  });

  it("maps stages and merges notes once", () => {
    expect(stageFromNotion("Churned")).toBe("former");
    expect(stageFromNotion(undefined)).toBe("client");
    const once = mergeNotes("Old notes", "New from Notion", "2026-10-16");
    expect(once).toContain("Imported from Notion on 2026-10-16");
    expect(mergeNotes(once, "New from Notion", "2026-10-17")).toBe(once);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

describeEmbeddedPostgres("Notion import route", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-notion-import-");
    db = createDb(tempDb.connectionString);
    await instanceSettingsService(db).updateExperimental({ enablePipelines: true });
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(organisations);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.delete(instanceSettings);
    await tempDb?.cleanup();
  });

  async function setup() {
    const [company] = await db
      .insert(companies)
      .values({ name: "Greatstone", issuePrefix: `N${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}` })
      .returning();
    const actor = {
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      companyIds: [company!.id],
      memberships: [],
      isInstanceAdmin: false,
    } as unknown as Express.Request["actor"];
    const app = express();
    app.use(express.json({ limit: "10mb" }));
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", organisationRoutes(db));
    app.use(errorHandler);
    return { companyId: company!.id, app };
  }

  it("previews without writing, imports, and adds nothing twice on a rerun", async () => {
    const { companyId, app } = await setup();
    await db.insert(organisations).values({ companyId, name: "Osei Farms", status: "client", notes: "Met at the expo." });
    const url = `/api/companies/${companyId}/organisations/import/notion`;

    const preview = await request(app).post(url).send({ mode: "preview", pages: PAGES });
    expect(preview.status).toBe(200);
    expect(preview.body.clients).toMatchObject([
      { name: "Kente Logistics", action: "create", status: "client", tasks: ["Send the revised proposal", "Ask for the fuel data", "Draft the weekly report template"] },
      { name: "Osei Farms", action: "update", status: "client", tasks: [] },
    ]);
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(0);

    const imported = await request(app).post(url).send({ mode: "import", pages: PAGES });
    expect(imported.status).toBe(200);
    expect(imported.body).toMatchObject({ organisations: { created: 1, updated: 1 }, tasksCreated: 3 });
    const orgs = await db.select().from(organisations).where(eq(organisations.companyId, companyId));
    const kente = orgs.find((row) => row.name === "Kente Logistics")!;
    expect(kente).toMatchObject({ source: "notion", externalId: "a".repeat(32), country: "Ghana", status: "client" });
    expect(orgs.find((row) => row.name === "Osei Farms")!.notes).toContain("Met at the expo.");
    const tasks = await db.select().from(issues).where(eq(issues.companyId, companyId));
    expect(tasks.map((task) => task.title)).toContain("Kente Logistics: Send the revised proposal");
    expect(tasks.every((task) => task.assigneeAgentId === null)).toBe(true);

    const again = await request(app).post(url).send({ mode: "import", pages: PAGES });
    expect(again.body).toMatchObject({ organisations: { created: 0, updated: 0 }, tasksCreated: 0 });
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(3);
  });

  it("imports only the clients picked in the preview, without tasks when asked", async () => {
    const { companyId, app } = await setup();
    const result = await request(app)
      .post(`/api/companies/${companyId}/organisations/import/notion`)
      .send({ mode: "import", pages: PAGES, include: [PAGES[3]!.path], createTasks: false });
    expect(result.body).toMatchObject({ organisations: { created: 1, updated: 0 }, tasksCreated: 0 });
    const orgs = await db.select().from(organisations).where(eq(organisations.companyId, companyId));
    expect(orgs.map((row) => [row.name, row.status])).toEqual([["Osei Farms", "prospect"]]);
  });
});
