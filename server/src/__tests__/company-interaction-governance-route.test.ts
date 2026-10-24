import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ISSUE_THREAD_INTERACTION_KINDS } from "@greatstone/shared";

const mockCompanyService = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  ensureMembership: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockCompanyPortabilityService = vi.hoisted(() => ({
  exportBundle: vi.fn(),
  previewExport: vi.fn(),
  previewImport: vi.fn(),
  importBundle: vi.fn(),
}));

const mockCompanyArtifactsService = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(),
  listFeedbackTraces: vi.fn(),
  getFeedbackTraceById: vi.fn(),
  saveIssueVote: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  budgetService: () => mockBudgetService,
  companyArtifactsService: () => mockCompanyArtifactsService,
  companyPortabilityService: () => mockCompanyPortabilityService,
  companyService: () => mockCompanyService,
  feedbackService: () => mockFeedbackService,
  instanceSettingsService: () => ({
    getExperimental: vi.fn(),
  }),
  logActivity: mockLogActivity,
}));

async function createApp() {
  const [{ companyRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/companies.js")>("../routes/companies.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { type: "board", userId: "user-1", source: "local_implicit" };
    next();
  });
  app.use("/api/companies", companyRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("PATCH /api/companies/:companyId interaction governance (GRE-2255)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/companies.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
    mockCompanyService.getById.mockResolvedValue({ id: "company-1", status: "active" });
    mockCompanyService.update.mockImplementation(async (id: string, body: unknown) => ({ id, ...(body as object) }));
  });

  it.each(ISSUE_THREAD_INTERACTION_KINDS)("saves a setting for the %s row", async (kind) => {
    const app = await createApp();
    const interactionResolverGovernance = { [kind]: { defaultPolicy: "human_only" } };

    const res = await request(app)
      .patch("/api/companies/company-1")
      .send({ interactionResolverGovernance });

    expect(res.status).toBe(200);
    expect(mockCompanyService.update).toHaveBeenCalledWith(
      "company-1",
      { interactionResolverGovernance },
      expect.anything(),
    );
  });

  it("still rejects a kind that does not exist", async () => {
    const app = await createApp();

    const res = await request(app)
      .patch("/api/companies/company-1")
      .send({ interactionResolverGovernance: { not_a_kind: { defaultPolicy: "human_only" } } });

    expect(res.status).toBe(400);
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });
});
