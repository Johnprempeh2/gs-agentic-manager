// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Project, ProjectWorkspace, WorkspaceRuntimeService } from "@greatstone/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LivePreviewCard, TaskPreviewLink } from "./LivePreviewCard";

const api = vi.hoisted(() => ({
  checkoutHead: vi.fn(),
  controlWorkspaceRuntimeServices: vi.fn(),
  updatePreview: vi.fn(),
  setPreviewAutoUpdate: vi.fn(),
}));
vi.mock("@/api/projects", () => ({ projectsApi: api }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) => (
    <a href={to} className={className}>{children}</a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => {});
}

const previewConfig = {
  workspaceRuntime: { services: [{ name: "preview", command: "pnpm vite", port: 4100 }] },
};

const previewWithUpdateJob = {
  workspaceRuntime: {
    commands: [
      { id: "preview", kind: "service", name: "preview", command: "pnpm vite", port: 4100 },
      { id: "update", kind: "job", name: "update to latest main", command: "git pull --ff-only origin main" },
    ],
  },
  desiredState: "running",
  serviceStates: null,
} as ProjectWorkspace["runtimeConfig"];

function runtimeService(overrides: Partial<WorkspaceRuntimeService> = {}): WorkspaceRuntimeService {
  const now = new Date();
  return {
    id: "service-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: "workspace-1",
    executionWorkspaceId: null,
    issueId: null,
    scopeType: "project_workspace",
    scopeId: "workspace-1",
    serviceName: "preview",
    status: "running",
    lifecycle: "shared",
    reuseKey: null,
    command: "pnpm vite",
    cwd: "/checkout",
    port: 4100,
    url: "http://127.0.0.1:4100",
    provider: "local_process",
    providerRef: null,
    ownerAgentId: null,
    startedByRunId: null,
    lastUsedAt: now,
    startedAt: now,
    stoppedAt: null,
    stopPolicy: null,
    healthStatus: "healthy",
    configIndex: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function buildProject(workspaceOverrides: Partial<ProjectWorkspace> = {}): Project {
  const workspace = {
    id: "workspace-1",
    companyId: "company-1",
    projectId: "project-1",
    name: "Site",
    sourceType: "git_repo",
    cwd: null,
    repoUrl: "https://github.com/example/site.git",
    repoRef: "main",
    defaultRef: "main",
    visibility: "default",
    setupCommand: null,
    cleanupCommand: null,
    remoteProvider: null,
    remoteWorkspaceRef: null,
    sharedWorkspaceKey: null,
    metadata: null,
    runtimeConfig: previewConfig,
    isPrimary: true,
    runtimeServices: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...workspaceOverrides,
  } as ProjectWorkspace;
  return {
    id: "project-1",
    companyId: "company-1",
    urlKey: "site",
    name: "Site",
    workspaces: [workspace],
    primaryWorkspace: workspace,
  } as unknown as Project;
}

describe("LivePreviewCard", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    api.checkoutHead.mockResolvedValue({
      workspaceId: "workspace-1",
      branch: "main",
      commit: "1a2b3c4",
      commitSubject: "Hero copy",
      committedAt: new Date().toISOString(),
    });
    api.controlWorkspaceRuntimeServices.mockResolvedValue({ workspace: {}, operation: {} });
    api.updatePreview.mockResolvedValue({ workspace: {} });
    api.setPreviewAutoUpdate.mockResolvedValue({ workspace: {} });
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    client.clear();
    container.remove();
    vi.clearAllMocks();
  });

  async function render(project: Project) {
    flushSync(() =>
      root.render(
        <QueryClientProvider client={client}>
          <LivePreviewCard project={project} companyId="company-1" />
        </QueryClientProvider>,
      ),
    );
    await flushReact();
  }

  function button(label: string) {
    return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  }

  it("shows the running preview link, status, branch and commit, and stops it", async () => {
    await render(buildProject({ runtimeServices: [runtimeService()] }));

    const card = container.querySelector('section[aria-label="Live preview"]');
    expect(card).not.toBeNull();
    const link = container.querySelector<HTMLAnchorElement>('a[href="http://127.0.0.1:4100"]');
    expect(link?.textContent).toContain("Open preview");
    expect(link?.target).toBe("_blank");
    expect(card?.textContent).toContain("Running");
    expect(card?.textContent).toContain("main");
    expect(card?.textContent).toContain("1a2b3c4");
    expect(card?.textContent).toContain("Started");
    expect(button("Restart")).not.toBeNull();

    flushSync(() => button("Stop")!.click());
    await flushReact();
    expect(api.controlWorkspaceRuntimeServices).toHaveBeenCalledWith(
      "project-1",
      "workspace-1",
      "stop",
      "company-1",
      expect.objectContaining({ action: "stop", runtimeServiceId: "service-1" }),
    );
  });

  it("shows a stopped preview with a Start button", async () => {
    const stoppedAt = new Date();
    await render(buildProject({
      runtimeServices: [runtimeService({ status: "stopped", stoppedAt })],
    }));

    const card = container.querySelector('section[aria-label="Live preview"]');
    expect(card?.textContent).toContain("Stopped");
    expect(card?.textContent).toContain("Not running");
    expect(container.querySelector("a[href='http://127.0.0.1:4100'][target='_blank']")).toBeNull();

    flushSync(() => button("Start")!.click());
    await flushReact();
    expect(api.controlWorkspaceRuntimeServices).toHaveBeenCalledWith(
      "project-1",
      "workspace-1",
      "start",
      "company-1",
      expect.objectContaining({ action: "start" }),
    );
  });

  it("shows a failed preview and the server error when restart is refused", async () => {
    api.controlWorkspaceRuntimeServices.mockRejectedValue(
      new Error("Project workspace needs a local path before GS Agentic Manager can run workspace commands"),
    );
    await render(buildProject({
      runtimeServices: [runtimeService({ status: "failed", stoppedAt: new Date() })],
    }));

    const card = container.querySelector('section[aria-label="Live preview"]');
    expect(card?.textContent).toContain("Failed");

    flushSync(() => button("Restart")!.click());
    await flushReact();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Could not restart the preview");
    expect(alert?.textContent).toContain("needs a local path");
    expect(alert?.querySelector("a")?.getAttribute("href")).toContain("/workspaces/workspace-1");
  });

  it("renders nothing for a project without a preview service", async () => {
    await render(buildProject({ runtimeConfig: null, runtimeServices: [] }));
    expect(container.innerHTML).toBe("");
    expect(api.checkoutHead).not.toHaveBeenCalled();
  });

  it("renders nothing for a project with only background services", async () => {
    await render(buildProject({
      runtimeConfig: {
        workspaceRuntime: { services: [{ name: "worker", command: "pnpm worker" }] },
        desiredState: null,
        serviceStates: null,
      } as ProjectWorkspace["runtimeConfig"],
    }));
    expect(container.innerHTML).toBe("");
  });

  it("hides Update now when the workspace has no update job", async () => {
    await render(buildProject({ runtimeServices: [runtimeService()] }));
    expect(container.textContent).not.toContain("Update now");
    expect(container.querySelector('[role="switch"]')).toBeNull();
  });

  it("runs Update now and shows the auto-update switch on by default", async () => {
    await render(buildProject({ runtimeConfig: previewWithUpdateJob, runtimeServices: [runtimeService()] }));

    const update = Array.from(container.querySelectorAll("button")).find((entry) => entry.textContent?.includes("Update now"));
    expect(update).toBeDefined();
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Auto-update on new commits"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("true");

    flushSync(() => update!.click());
    await flushReact();
    expect(api.updatePreview).toHaveBeenCalledWith("project-1", "workspace-1", "company-1");

    flushSync(() => toggle!.click());
    await flushReact();
    expect(api.setPreviewAutoUpdate).toHaveBeenCalledWith("project-1", "workspace-1", false, "company-1");
  });

  it("shows an update in progress", async () => {
    await render(buildProject({
      runtimeConfig: previewWithUpdateJob,
      runtimeServices: [runtimeService()],
      metadata: { previewUpdate: { status: "updating", trigger: "auto" } },
    }));
    const update = Array.from(container.querySelectorAll("button")).find((entry) => entry.textContent?.includes("Updating"));
    expect(update?.disabled).toBe(true);
    expect(container.textContent).toContain("Pulling the latest code");
  });

  it("shows the commit the last update moved to", async () => {
    await render(buildProject({
      runtimeConfig: previewWithUpdateJob,
      runtimeServices: [runtimeService()],
      metadata: { previewUpdate: { status: "updated", commit: "9f8e7d6", updatedAt: "2026-10-07T14:05:00.000Z", autoUpdate: false } },
    }));
    expect(container.textContent).toContain("Updated to 9f8e7d6 at");
    expect(container.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
  });

  it("shows why an update was skipped or failed", async () => {
    await render(buildProject({
      runtimeConfig: previewWithUpdateJob,
      runtimeServices: [runtimeService()],
      metadata: { previewUpdate: { status: "skipped", message: "Not updated: the checkout has uncommitted changes in 2 files." } },
    }));
    expect(container.textContent).toContain("uncommitted changes in 2 files");

    await render(buildProject({
      runtimeConfig: previewWithUpdateJob,
      runtimeServices: [runtimeService()],
      metadata: { previewUpdate: { status: "failed", message: "Update failed: npm install exited with code 1" } },
    }));
    expect(container.textContent).toContain("Update failed: npm install exited with code 1");
    const logs = Array.from(container.querySelectorAll("a")).find((entry) => entry.textContent === "View workspace logs");
    expect(logs?.getAttribute("href")).toContain("/workspaces/workspace-1");
  });

  it("names the project when asked to", async () => {
    flushSync(() =>
      root.render(
        <QueryClientProvider client={client}>
          <LivePreviewCard project={buildProject({ runtimeServices: [runtimeService()] })} companyId="company-1" showProjectName />
        </QueryClientProvider>,
      ),
    );
    await flushReact();
    const name = container.querySelector<HTMLAnchorElement>('section[aria-label="Live preview"] a[href*="/projects/"]');
    expect(name?.textContent).toBe("Site");
  });
});

describe("TaskPreviewLink", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  it("links to the running service of the task workspace", () => {
    flushSync(() =>
      root.render(
        <TaskPreviewLink
          workspace={{ branchName: "GRE-1-hero", runtimeServices: [runtimeService({ url: "http://127.0.0.1:4200" })] }}
        />,
      ),
    );
    const link = container.querySelector<HTMLAnchorElement>("a");
    expect(link?.href).toBe("http://127.0.0.1:4200/");
    expect(link?.target).toBe("_blank");
    expect(container.textContent).toContain("GRE-1-hero");
  });

  it("renders nothing when no service is running", () => {
    flushSync(() =>
      root.render(
        <TaskPreviewLink workspace={{ branchName: "x", runtimeServices: [runtimeService({ status: "stopped" })] }} />,
      ),
    );
    expect(container.innerHTML).toBe("");
  });
});
