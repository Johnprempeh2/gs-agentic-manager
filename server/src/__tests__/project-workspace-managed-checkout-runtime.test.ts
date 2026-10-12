import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
  listWorkspaces: vi.fn(),
  updateWorkspace: vi.fn(),
}));
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));
const mockStartRuntimeServices = vi.hoisted(() => vi.fn());
const mockWorkspaceOperationService = vi.hoisted(() => ({
  createRecorder: () => ({
    recordOperation: async (input: { run: () => Promise<unknown> }) => {
      await input.run();
      return { id: "operation-1" };
    },
  }),
}));

function registerMocks() {
  vi.doMock("../telemetry.js", () => ({ getTelemetryClient: vi.fn() }));
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    logActivity: vi.fn(),
    projectService: () => mockProjectService,
    workspaceOperationService: () => mockWorkspaceOperationService,
  }));
  vi.doMock("../services/workspace-runtime.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../services/workspace-runtime.js")>()),
    startRuntimeServicesForWorkspaceControl: mockStartRuntimeServices,
    stopRuntimeServicesForProjectWorkspace: vi.fn(),
  }));
  vi.doMock("../routes/workspace-runtime-service-authz.js", () => ({
    assertCanManageProjectWorkspaceRuntimeServices: vi.fn(async () => undefined),
  }));
}

let importCounter = 0;
async function createApp() {
  registerMocks();
  importCounter += 1;
  const routeModulePath = `../routes/projects.js?managed-checkout-${importCounter}`;
  const middlewareModulePath = `../middleware/index.js?managed-checkout-${importCounter}`;
  const [{ projectRoutes }, { errorHandler }] = await Promise.all([
    import(routeModulePath) as Promise<typeof import("../routes/projects.js")>,
    import(middlewareModulePath) as Promise<typeof import("../middleware/index.js")>,
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

const projectId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const repoUrl = "https://github.com/example/site.git";

function buildProject(managedFolder: string) {
  const workspace = {
    id: workspaceId,
    companyId: "company-1",
    projectId,
    name: "Site",
    sourceType: "git_repo",
    cwd: null,
    repoUrl,
    repoRef: "main",
    defaultRef: "main",
    visibility: "default",
    setupCommand: null,
    cleanupCommand: null,
    remoteProvider: null,
    remoteWorkspaceRef: null,
    sharedWorkspaceKey: null,
    metadata: null,
    runtimeConfig: {
      workspaceRuntime: { services: [{ name: "preview", command: "pnpm dev", url: "http://127.0.0.1:4100" }] },
    },
    isPrimary: true,
    runtimeServices: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return {
    id: projectId,
    companyId: "company-1",
    name: "Site",
    codebase: {
      workspaceId,
      repoUrl,
      repoRef: "main",
      defaultRef: "main",
      repoName: "site",
      localFolder: null,
      managedFolder,
      effectiveLocalFolder: managedFolder,
      origin: "managed_checkout",
    },
    workspaces: [workspace],
    primaryWorkspace: workspace,
  };
}

describe.sequential("project workspace commands on a managed checkout", () => {
  let tempRoot: string;
  let managedFolder: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gsam-managed-checkout-"));
    managedFolder = path.join(tempRoot, "site");
    mockAccessService.decide.mockResolvedValue({ allowed: true, action: "runtime:manage", reason: "allow_test", explanation: "" });
    mockProjectService.updateWorkspace.mockResolvedValue(null);
    mockStartRuntimeServices.mockResolvedValue([{ id: "service-1" }]);
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("starts services in the managed checkout when the workspace has no local path", async () => {
    fs.mkdirSync(managedFolder, { recursive: true });
    execFileSync("git", ["init", "-q", managedFolder]);
    execFileSync("git", ["-C", managedFolder, "remote", "add", "origin", repoUrl]);
    const project = buildProject(managedFolder);
    mockProjectService.getById.mockResolvedValue(project);
    mockProjectService.listWorkspaces.mockResolvedValue(project.workspaces);

    const res = await request(await createApp())
      .post(`/api/projects/${projectId}/workspaces/${workspaceId}/runtime-services/start`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockStartRuntimeServices).toHaveBeenCalledTimes(1);
    const call = mockStartRuntimeServices.mock.calls[0]![0] as { workspace: { cwd: string; baseCwd: string } };
    expect(call.workspace.cwd).toBe(managedFolder);
    expect(call.workspace.baseCwd).toBe(managedFolder);
  }, 15000);

  it("still asks for a local path when the managed checkout was never cloned", async () => {
    const project = buildProject(managedFolder);
    mockProjectService.getById.mockResolvedValue(project);

    const res = await request(await createApp())
      .post(`/api/projects/${projectId}/workspaces/${workspaceId}/runtime-services/start`)
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("needs a local path");
    expect(mockStartRuntimeServices).not.toHaveBeenCalled();
  }, 15000);

  it("ignores a managed folder that holds a different repository", async () => {
    fs.mkdirSync(managedFolder, { recursive: true });
    execFileSync("git", ["init", "-q", managedFolder]);
    execFileSync("git", ["-C", managedFolder, "remote", "add", "origin", "https://github.com/example/other.git"]);
    mockProjectService.getById.mockResolvedValue(buildProject(managedFolder));

    const res = await request(await createApp())
      .post(`/api/projects/${projectId}/workspaces/${workspaceId}/runtime-services/start`)
      .send({});

    expect(res.status).toBe(422);
    expect(mockStartRuntimeServices).not.toHaveBeenCalled();
  }, 15000);

  it("reports the branch and commit of the managed checkout", async () => {
    fs.mkdirSync(managedFolder, { recursive: true });
    const gitIn = (...args: string[]) => execFileSync("git", ["-C", managedFolder, ...args]);
    execFileSync("git", ["init", "-q", "-b", "main", managedFolder]);
    gitIn("remote", "add", "origin", repoUrl);
    gitIn("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "Hero copy");
    const expectedCommit = gitIn("rev-parse", "--short", "HEAD").toString().trim();
    mockProjectService.getById.mockResolvedValue(buildProject(managedFolder));

    const res = await request(await createApp())
      .get(`/api/projects/${projectId}/workspaces/${workspaceId}/checkout-head`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      workspaceId,
      branch: "main",
      commit: expectedCommit,
      commitSubject: "Hero copy",
    });
    expect(typeof res.body.committedAt).toBe("string");
  }, 15000);

  it("reports an empty head when there is no checkout", async () => {
    mockProjectService.getById.mockResolvedValue(buildProject(managedFolder));

    const res = await request(await createApp())
      .get(`/api/projects/${projectId}/workspaces/${workspaceId}/checkout-head`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ workspaceId, branch: null, commit: null, commitSubject: null, committedAt: null });
  }, 15000);
});
