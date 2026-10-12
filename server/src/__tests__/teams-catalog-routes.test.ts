import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockTeamsCatalogService = vi.hoisted(() => ({
  previewCatalogTeamImport: vi.fn(),
  installCatalogTeam: vi.fn(),
  listInstalledCatalogTeams: vi.fn(),
  requestCatalogTeam: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(),
}));

const mockCatalogModule = vi.hoisted(() => ({
  catalogTeamMatchesFilter: (team: { tags: string[] }, filter?: string) =>
    !filter || filter === "all" || team.tags.includes("greatstone"),
  listCatalogTeams: vi.fn(),
  getCatalogTeamOrThrow: vi.fn(),
  readCatalogTeamFile: vi.fn(),
  teamsCatalogService: vi.fn(() => mockTeamsCatalogService),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/teams-catalog.js", () => mockCatalogModule);
}

async function createApp(actor: Record<string, unknown>) {
  const [{ teamsCatalogRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/teams-catalog.js")>("../routes/teams-catalog.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", teamsCatalogRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function catalogTeam(overrides: Record<string, unknown> = {}) {
  return {
    id: "paperclipai:bundled:software-development:product-engineering",
    key: "paperclipai/bundled/software-development/product-engineering",
    kind: "bundled",
    category: "software-development",
    slug: "product-engineering",
    name: "Product Engineering",
    description: "A software development team with CTO, coder, and QA roles.",
    path: "catalog/bundled/software-development/product-engineering",
    entrypoint: "TEAM.md",
    schema: "agentcompanies/v1",
    defaultInstall: true,
    recommendedForCompanyTypes: ["software"],
    tags: ["engineering"],
    counts: { agents: 3, projects: 1, tasks: 1, routines: 0, localSkills: 0, catalogSkills: 1, externalSkillSources: 0 },
    rootAgentSlugs: ["cto"],
    agentSlugs: ["cto", "senior-coder", "qa"],
    projectSlugs: ["product-engineering"],
    requiredSkills: [],
    envInputs: [],
    sourceRefs: [],
    files: [{ path: "TEAM.md", kind: "team", sizeBytes: 128, sha256: "sha256:team" }],
    trustLevel: "markdown_only",
    compatibility: "compatible",
    contentHash: "sha256:catalog-team",
    ...overrides,
  };
}

const companyId = "11111111-1111-4111-8111-111111111111";

describe("teams catalog routes", () => {
  beforeEach(() => {
    vi.resetModules();
    registerModuleMocks();
    vi.clearAllMocks();
    mockInstanceSettingsService.getGeneral.mockResolvedValue({ teamCatalogFilter: "all" });
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId,
      permissions: { canCreateAgents: true },
    });
    mockCatalogModule.listCatalogTeams.mockReturnValue([catalogTeam()]);
    mockCatalogModule.getCatalogTeamOrThrow.mockReturnValue(catalogTeam());
    mockCatalogModule.readCatalogTeamFile.mockResolvedValue({
      catalogTeamId: "paperclipai:bundled:software-development:product-engineering",
      path: "TEAM.md",
      kind: "team",
      content: "# Product Engineering",
      language: "markdown",
      markdown: true,
    });
    mockTeamsCatalogService.previewCatalogTeamImport.mockResolvedValue({
      team: catalogTeam(),
      portabilityPreview: {
        plan: { companyAction: "none", agentPlans: [], projectPlans: [], issuePlans: [] },
        warnings: [],
        errors: [],
      },
      skillPreparations: [],
      warnings: [],
      errors: [],
    });
    mockTeamsCatalogService.listInstalledCatalogTeams.mockResolvedValue([
      {
        catalogId: "paperclipai:bundled:software-development:product-engineering",
        catalogKey: "paperclipai/bundled/software-development/product-engineering",
        present: true,
        currentContentHash: "sha256:catalog-team",
        installedOriginHashes: ["sha256:old"],
        agentCount: 3,
        outOfDate: true,
      },
    ]);
    mockTeamsCatalogService.installCatalogTeam.mockResolvedValue({
      team: catalogTeam(),
      portabilityImport: {
        company: { id: companyId, name: "GS Agentic Manager", action: "unchanged" },
        agents: [],
        projects: [],
        envInputs: [],
        warnings: [],
      },
      skillPreparations: [],
      warnings: [],
    });
  });

  it("serves catalog listings, details, and files for authenticated actors", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    });

    const list = await request(app).get("/api/teams/catalog?kind=bundled&q=engineering");
    const detail = await request(app).get("/api/teams/catalog/product-engineering");
    const file = await request(app).get("/api/teams/catalog/product-engineering/files?path=TEAM.md");

    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(file.status, JSON.stringify(file.body)).toBe(200);
    expect(mockCatalogModule.listCatalogTeams).toHaveBeenCalledWith({ kind: "bundled", q: "engineering" });
    expect(mockCatalogModule.getCatalogTeamOrThrow).toHaveBeenCalledWith("product-engineering");
    expect(mockCatalogModule.readCatalogTeamFile).toHaveBeenCalledWith("product-engineering", "TEAM.md");
  });

  it("returns server-computed installed-team state for actors with company access", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    });

    const res = await request(app).get(`/api/companies/${companyId}/teams/catalog/installed`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockTeamsCatalogService.listInstalledCatalogTeams).toHaveBeenCalledWith(companyId);
    expect(res.body).toEqual([
      expect.objectContaining({
        catalogId: "paperclipai:bundled:software-development:product-engineering",
        present: true,
        outOfDate: true,
        agentCount: 3,
      }),
    ]);
  });

  it("denies installed-team state to actors without company access", async () => {
    const app = await createApp({
      type: "board",
      userId: "other",
      companyIds: ["22222222-2222-4222-8222-222222222222"],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app).get(`/api/companies/${companyId}/teams/catalog/installed`);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockTeamsCatalogService.listInstalledCatalogTeams).not.toHaveBeenCalled();
  });

  it("requires authentication for catalog read routes", async () => {
    const app = await createApp({ type: "none" });

    const list = await request(app).get("/api/teams/catalog");
    const detail = await request(app).get("/api/teams/catalog/product-engineering");
    const file = await request(app).get("/api/teams/catalog/product-engineering/files?path=TEAM.md");

    expect(list.status, JSON.stringify(list.body)).toBe(401);
    expect(detail.status, JSON.stringify(detail.body)).toBe(401);
    expect(file.status, JSON.stringify(file.body)).toBe(401);
    expect(mockCatalogModule.listCatalogTeams).not.toHaveBeenCalled();
  });

  it("previews catalog teams with company access and actor/source policy context", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
      runId: "run-1",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/teams/catalog/ref/preview?ref=paperclipai%2Fbundled%2Fsoftware-development%2Fproduct-engineering`)
      .send({
        targetManagerSlug: "engineering-lead",
        sourcePolicy: { allowExternalSources: true },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockTeamsCatalogService.previewCatalogTeamImport).toHaveBeenCalledWith(
      companyId,
      "paperclipai/bundled/software-development/product-engineering",
      expect.objectContaining({
        targetManagerSlug: "engineering-lead",
        sourcePolicy: { allowExternalSources: true },
        actor: expect.objectContaining({
          actorType: "user",
          actorId: "local-board",
          runId: "run-1",
        }),
      }),
    );
  });

  it("rejects catalog preview requests that try to include company metadata", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/teams/catalog/product-engineering/preview`)
      .send({
        include: { company: true, agents: true },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(mockTeamsCatalogService.previewCatalogTeamImport).not.toHaveBeenCalled();
  });

  it("installs catalog teams only for actors that can create agents", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId,
      runId: "run-1",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/teams/catalog/product-engineering/install`)
      .send({
        collisionStrategy: "rename",
        secretValues: { "agent:cto:OPENAI_API_KEY": "sk-test" },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockTeamsCatalogService.installCatalogTeam).toHaveBeenCalledWith(
      companyId,
      "product-engineering",
      expect.objectContaining({
        collisionStrategy: "rename",
        secretValues: { "agent:cto:OPENAI_API_KEY": "sk-test" },
        actor: expect.objectContaining({
          actorType: "agent",
          actorId: "agent-1",
          agentId: "agent-1",
          runId: "run-1",
        }),
      }),
    );
  });

  it("blocks same-company agents without management permission from installing catalog teams", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId,
      permissions: {},
    });
    mockAccessService.hasPermission.mockResolvedValue(false);
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId,
      runId: "run-1",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/teams/catalog/product-engineering/install`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockTeamsCatalogService.installCatalogTeam).not.toHaveBeenCalled();
  });

  describe("Greatstone-only catalogue filter (GRE-427)", () => {
    const boardActor = {
      type: "board",
      userId: "local-board",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    };

    beforeEach(() => {
      mockInstanceSettingsService.getGeneral.mockResolvedValue({ teamCatalogFilter: "greatstone" });
    });

    it("asks the catalogue for Greatstone teams only when the filter is on", async () => {
      const app = await createApp(boardActor);

      const list = await request(app).get("/api/teams/catalog?kind=optional");

      expect(list.status, JSON.stringify(list.body)).toBe(200);
      expect(mockCatalogModule.listCatalogTeams).toHaveBeenCalledWith({
        kind: "optional",
        filter: "greatstone",
      });
    });

    it("lists every team when the filter is off", async () => {
      mockInstanceSettingsService.getGeneral.mockResolvedValue({ teamCatalogFilter: "all" });
      const app = await createApp(boardActor);

      await request(app).get("/api/teams/catalog");

      expect(mockCatalogModule.listCatalogTeams).toHaveBeenCalledWith({});
    });

    it("hides an upstream engineering team from detail, files, preview and install", async () => {
      const app = await createApp(boardActor);

      const detail = await request(app).get("/api/teams/catalog/product-engineering");
      const file = await request(app).get("/api/teams/catalog/product-engineering/files?path=TEAM.md");
      const preview = await request(app)
        .post(`/api/companies/${companyId}/teams/catalog/product-engineering/preview`)
        .send({});
      const install = await request(app)
        .post(`/api/companies/${companyId}/teams/catalog/product-engineering/install`)
        .send({});

      for (const res of [detail, file, preview, install]) {
        expect(res.status, JSON.stringify(res.body)).toBe(404);
      }
      expect(mockCatalogModule.readCatalogTeamFile).not.toHaveBeenCalled();
      expect(mockTeamsCatalogService.previewCatalogTeamImport).not.toHaveBeenCalled();
      expect(mockTeamsCatalogService.installCatalogTeam).not.toHaveBeenCalled();
    });

    it("still installs a Greatstone team when the filter is on", async () => {
      mockCatalogModule.getCatalogTeamOrThrow.mockReturnValue(
        catalogTeam({ slug: "marketing-content", tags: ["greatstone", "marketing"] }),
      );
      const app = await createApp(boardActor);

      const res = await request(app)
        .post(`/api/companies/${companyId}/teams/catalog/marketing-content/install`)
        .send({ targetManagerAgentId: "33333333-3333-4333-8333-333333333333" });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(mockTeamsCatalogService.installCatalogTeam).toHaveBeenCalledWith(
        companyId,
        "marketing-content",
        expect.objectContaining({ targetManagerAgentId: "33333333-3333-4333-8333-333333333333" }),
      );
    });
  });

  describe("Ask Greatstone to add (GRE-434)", () => {
    const boardActor = {
      type: "board",
      userId: "local-board",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    const marketingTeam = catalogTeam({
      id: "paperclipai:optional:marketing:marketing-content",
      key: "paperclipai/optional/marketing/marketing-content",
      slug: "marketing-content",
      name: "Marketing Content Team",
      tags: ["greatstone", "marketing"],
    });

    beforeEach(() => {
      mockInstanceSettingsService.getGeneral.mockResolvedValue({
        teamCatalogFilter: "greatstone",
        teamCatalogAddMode: "request",
      });
      mockCatalogModule.getCatalogTeamOrThrow.mockReturnValue(marketingTeam);
      mockTeamsCatalogService.requestCatalogTeam.mockResolvedValue({
        approval: { id: "approval-1", type: "request_board_approval", status: "pending" },
        created: true,
      });
    });

    it("makes an approval card that names the team and installs nothing", async () => {
      const app = await createApp(boardActor);

      const res = await request(app)
        .post(`/api/companies/${companyId}/teams/catalog/marketing-content/request`)
        .send({});

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ id: "approval-1", type: "request_board_approval" });
      expect(mockTeamsCatalogService.requestCatalogTeam).toHaveBeenCalledWith(
        companyId,
        expect.objectContaining({ key: "paperclipai/optional/marketing/marketing-content" }),
        expect.objectContaining({ actorType: "user", actorId: "local-board" }),
      );
      expect(mockTeamsCatalogService.installCatalogTeam).not.toHaveBeenCalled();
    });

    it("returns the open card when the team was already asked for", async () => {
      mockTeamsCatalogService.requestCatalogTeam.mockResolvedValue({
        approval: { id: "approval-1", type: "request_board_approval", status: "pending" },
        created: false,
      });
      const app = await createApp(boardActor);

      const res = await request(app)
        .post(`/api/companies/${companyId}/teams/catalog/marketing-content/request`)
        .send({});

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.id).toBe("approval-1");
    });

    it("uses the install permission check", async () => {
      mockAgentService.getById.mockResolvedValue({ id: "agent-1", companyId, permissions: {} });
      const agentApp = await createApp({ type: "agent", agentId: "agent-1", companyId, runId: "run-1" });
      const otherCompanyApp = await createApp({
        ...boardActor,
        userId: "other",
        companyIds: ["22222222-2222-4222-8222-222222222222"],
        source: "session",
      });

      const byAgent = await request(agentApp)
        .post(`/api/companies/${companyId}/teams/catalog/marketing-content/request`)
        .send({});
      const byOtherCompany = await request(otherCompanyApp)
        .post(`/api/companies/${companyId}/teams/catalog/marketing-content/request`)
        .send({});

      expect(byAgent.status, JSON.stringify(byAgent.body)).toBe(403);
      expect(byOtherCompany.status, JSON.stringify(byOtherCompany.body)).toBe(403);
      expect(mockTeamsCatalogService.requestCatalogTeam).not.toHaveBeenCalled();
    });

    it("refuses a request when the instance installs teams directly", async () => {
      mockInstanceSettingsService.getGeneral.mockResolvedValue({
        teamCatalogFilter: "all",
        teamCatalogAddMode: "install",
      });
      const app = await createApp(boardActor);

      const res = await request(app)
        .post(`/api/companies/${companyId}/teams/catalog/marketing-content/request`)
        .send({});

      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(mockTeamsCatalogService.requestCatalogTeam).not.toHaveBeenCalled();
    });

    it("hides a team the catalogue filter does not offer", async () => {
      mockCatalogModule.getCatalogTeamOrThrow.mockReturnValue(catalogTeam());
      const app = await createApp(boardActor);

      const res = await request(app)
        .post(`/api/companies/${companyId}/teams/catalog/product-engineering/request`)
        .send({});

      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(mockTeamsCatalogService.requestCatalogTeam).not.toHaveBeenCalled();
    });
  });

  describe("install honours the add mode (GRE-668)", () => {
    const clientBoardUser = {
      type: "board",
      userId: "client-owner",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    };
    const instanceAdmin = {
      type: "board",
      userId: "greatstone-operator",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: true,
    };

    function installAs(actor: Record<string, unknown>) {
      return createApp(actor).then((app) =>
        request(app).post(`/api/companies/${companyId}/teams/catalog/product-engineering/install`).send({}),
      );
    }

    function setAddMode(teamCatalogAddMode: "request" | "install") {
      mockInstanceSettingsService.getGeneral.mockResolvedValue({ teamCatalogFilter: "all", teamCatalogAddMode });
    }

    it("refuses a client board user in request mode and installs nothing", async () => {
      setAddMode("request");

      const res = await installAs(clientBoardUser);

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toMatch(/use request/i);
      expect(mockTeamsCatalogService.installCatalogTeam).not.toHaveBeenCalled();
    });

    it("lets the instance admin install in request mode", async () => {
      setAddMode("request");

      const res = await installAs(instanceAdmin);

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(mockTeamsCatalogService.installCatalogTeam).toHaveBeenCalledTimes(1);
    });

    it("lets a client board user install in install mode", async () => {
      setAddMode("install");

      const res = await installAs(clientBoardUser);

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(mockAccessService.canUser).toHaveBeenCalledWith(companyId, "client-owner", "agents:create");
      expect(mockTeamsCatalogService.installCatalogTeam).toHaveBeenCalledTimes(1);
    });

    it("lets the instance admin install in install mode", async () => {
      setAddMode("install");

      const res = await installAs(instanceAdmin);

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(mockTeamsCatalogService.installCatalogTeam).toHaveBeenCalledTimes(1);
    });

    it("keeps the agent rule in request mode", async () => {
      setAddMode("request");

      const res = await installAs({ type: "agent", agentId: "agent-1", companyId, runId: "run-1" });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(mockTeamsCatalogService.installCatalogTeam).toHaveBeenCalledTimes(1);
    });

    it("still lets a client board user ask in request mode", async () => {
      setAddMode("request");
      mockTeamsCatalogService.requestCatalogTeam.mockResolvedValue({
        approval: { id: "approval-1", type: "request_board_approval", status: "pending" },
        created: true,
      });
      const app = await createApp(clientBoardUser);

      const res = await request(app)
        .post(`/api/companies/${companyId}/teams/catalog/product-engineering/request`)
        .send({});

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(mockTeamsCatalogService.installCatalogTeam).not.toHaveBeenCalled();
    });
  });
});
