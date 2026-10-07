import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
  listWorkspaces: vi.fn(),
}));
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockPreviewUpdates = vi.hoisted(() => ({
  update: vi.fn(),
  setAutoUpdate: vi.fn(),
}));
const mockAssertCanManage = vi.hoisted(() => vi.fn(async () => undefined));

function registerMocks() {
  vi.doMock("../telemetry.js", () => ({ getTelemetryClient: vi.fn() }));
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    logActivity: mockLogActivity,
    projectService: () => mockProjectService,
    workspaceOperationService: () => ({ createRecorder: vi.fn() }),
  }));
  vi.doMock("../services/preview-update.js", () => ({
    previewUpdateService: () => mockPreviewUpdates,
  }));
  vi.doMock("../routes/workspace-runtime-service-authz.js", () => ({
    assertCanManageProjectWorkspaceRuntimeServices: mockAssertCanManage,
  }));
}

let importCounter = 0;
async function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "board-1",
  companyIds: ["company-1"],
  source: "session",
  isInstanceAdmin: false,
}) {
  registerMocks();
  importCounter += 1;
  const routeModulePath = `../routes/projects.js?preview-update-${importCounter}`;
  const middlewareModulePath = `../middleware/index.js?preview-update-${importCounter}`;
  const [{ projectRoutes }, { errorHandler }] = await Promise.all([
    import(routeModulePath) as Promise<typeof import("../routes/projects.js")>,
    import(middlewareModulePath) as Promise<typeof import("../middleware/index.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", projectRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const projectId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const workspace = {
  id: workspaceId,
  companyId: "company-1",
  projectId,
  cwd: "/tmp/site",
  sharedWorkspaceKey: null,
  metadata: null,
  runtimeConfig: null,
  runtimeServices: [],
};
const project = { id: projectId, companyId: "company-1", workspaces: [workspace] };
const base = `/api/projects/${projectId}/workspaces/${workspaceId}`;

describe.sequential("project workspace preview update routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({ allowed: true });
    mockProjectService.getById.mockResolvedValue(project);
    mockProjectService.listWorkspaces.mockResolvedValue([{ ...workspace, metadata: { previewUpdate: { status: "updating" } } }]);
  });

  it("starts an update and answers 202 with the updating workspace", async () => {
    mockPreviewUpdates.update.mockImplementation(async (input: { onStarted?: () => void }) => {
      input.onStarted?.();
      return new Promise(() => undefined);
    });
    const app = await createApp();

    const res = await request(app).post(`${base}/preview-update`).send({});

    expect(res.status).toBe(202);
    expect(res.body.workspace.metadata.previewUpdate.status).toBe("updating");
    expect(mockPreviewUpdates.update).toHaveBeenCalledWith(expect.objectContaining({
      projectId,
      workspaceId,
      trigger: "manual",
      actor: { actorType: "user", actorId: "board-1", agentId: null },
    }));
    expect(mockAssertCanManage).toHaveBeenCalled();
  });

  it("answers 409 while an update is already running", async () => {
    mockPreviewUpdates.update.mockResolvedValue({ kind: "busy" });
    const res = await request(await createApp()).post(`${base}/preview-update`).send({});
    expect(res.status).toBe(409);
  });

  it("answers 422 when the workspace has no update job", async () => {
    mockPreviewUpdates.update.mockResolvedValue({ kind: "no_update_job" });
    const res = await request(await createApp()).post(`${base}/preview-update`).send({});
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/no update job/);
  });

  it("refuses callers without runtime:manage", async () => {
    mockAccessService.decide.mockResolvedValue({ allowed: false });
    const app = await createApp();
    const update = await request(app).post(`${base}/preview-update`).send({});
    const toggle = await request(app).patch(`${base}/preview-auto-update`).send({ enabled: false });
    expect(update.status).toBe(403);
    expect(toggle.status).toBe(403);
    expect(mockPreviewUpdates.update).not.toHaveBeenCalled();
    expect(mockPreviewUpdates.setAutoUpdate).not.toHaveBeenCalled();
  });

  it("returns 404 for a workspace outside the project", async () => {
    const res = await request(await createApp())
      .post(`/api/projects/${projectId}/workspaces/33333333-3333-4333-8333-333333333333/preview-update`)
      .send({});
    expect(res.status).toBe(404);
  });

  it("switches auto-update off and logs who did it", async () => {
    const app = await createApp();
    const res = await request(app).patch(`${base}/preview-auto-update`).send({ enabled: false });
    expect(res.status).toBe(200);
    expect(mockPreviewUpdates.setAutoUpdate).toHaveBeenCalledWith(workspaceId, false);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "project.workspace_preview_auto_update_set",
      details: { projectWorkspaceId: workspaceId, enabled: false },
    }));
  });

  it("rejects a toggle body without a boolean", async () => {
    const res = await request(await createApp()).patch(`${base}/preview-auto-update`).send({ enabled: "yes" });
    expect(res.status).toBe(400);
    expect(mockPreviewUpdates.setAutoUpdate).not.toHaveBeenCalled();
  });
});
