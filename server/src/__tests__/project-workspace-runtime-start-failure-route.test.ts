import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GRE-1002: a project-workspace service whose readiness check fails answered with a bare
 * `500 Internal server error`; the reason was only in the server log. The route must
 * return the start failure as a 4xx with that reason.
 */

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
  listWorkspaces: vi.fn(),
  updateWorkspace: vi.fn(),
}));
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));
const mockWorkspaceOperationService = vi.hoisted(() => ({ createRecorder: vi.fn() }));
const mockStartRuntimeServices = vi.hoisted(() => vi.fn());
const mockStopRuntimeServicesForProjectWorkspace = vi.hoisted(() => vi.fn());
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.js", () => ({ getTelemetryClient: vi.fn() }));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  environmentService: () => ({ getById: vi.fn() }),
  executionWorkspaceService: () => ({ getById: vi.fn(), update: vi.fn() }),
  heartbeatService: () => ({}),
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
  secretService: () => ({ normalizeEnvBindingsForPersistence: vi.fn() }),
  workspaceOperationService: () => mockWorkspaceOperationService,
  workspaceRuntimeLeaseService: () => ({ claim: vi.fn(), release: vi.fn(), get: vi.fn() }),
  LEASED_WORKSPACE_RUNTIME_ACTIONS: ["start", "stop", "restart", "repair"],
}));

vi.mock("../services/workspace-runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../services/workspace-runtime.js")>("../services/workspace-runtime.js")),
  startRuntimeServicesForWorkspaceControl: mockStartRuntimeServices,
  stopRuntimeServicesForProjectWorkspace: mockStopRuntimeServicesForProjectWorkspace,
}));

vi.mock("../routes/workspace-runtime-service-authz.js", () => ({
  assertCanManageProjectWorkspaceRuntimeServices: vi.fn(),
  assertCanManageExecutionWorkspaceRuntimeServices: vi.fn(),
}));

const projectId = "44444444-4444-4444-8444-444444444444";
const workspaceId = "55555555-5555-4555-8555-555555555555";
const readinessFailure =
  "Failed to start runtime service \"web\": Readiness check failed for http://127.0.0.1:41234/: fetch failed: connect ECONNREFUSED 127.0.0.1:41234 (3 probes over 1000ms)";

async function createApp() {
  const [{ projectRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/projects.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", projectRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("project workspace runtime start failure (GRE-1002)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const workspace = {
      id: workspaceId,
      companyId: "company-1",
      projectId,
      name: "Primary",
      cwd: "/tmp/gre-1002",
      repoUrl: null,
      repoRef: null,
      defaultRef: null,
      sharedWorkspaceKey: null,
      runtimeConfig: {
        workspaceRuntime: {
          services: [{
            name: "web",
            command: "python3 -c \"import sys; sys.exit(1)\"",
            lifecycle: "shared",
            readiness: { type: "http", urlTemplate: "http://127.0.0.1:{{port}}" },
          }],
        },
      },
      runtimeServices: [],
    };
    mockProjectService.getById.mockResolvedValue({
      id: projectId,
      companyId: "company-1",
      workspaces: [workspace],
    });
    mockProjectService.listWorkspaces.mockResolvedValue([workspace]);
    mockAccessService.decide.mockResolvedValue({ allowed: true, reason: "allow_test" });
    // The real recorder marks the operation failed and rethrows the run error unchanged.
    mockWorkspaceOperationService.createRecorder.mockReturnValue({
      recordOperation: async (input: { run: () => Promise<unknown> }) => {
        await input.run();
        return { id: "operation-1", status: "succeeded" };
      },
    });
    mockStartRuntimeServices.mockRejectedValue(new Error(readinessFailure));
  });

  it("returns the readiness failure reason instead of a bare 500", async () => {
    const res = await request(await createApp())
      .post(`/api/projects/${projectId}/workspaces/${workspaceId}/runtime-services/start`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toBe(readinessFailure);
    expect(res.body.code).toBe("workspace_runtime_command_failed");
    expect(mockStartRuntimeServices).toHaveBeenCalledTimes(1);
    // A failed start must not record the desired state as running.
    expect(mockProjectService.updateWorkspace).not.toHaveBeenCalled();
  });
});
