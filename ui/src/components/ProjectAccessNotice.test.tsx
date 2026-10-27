// @vitest-environment jsdom
import { act, type AnchorHTMLAttributes } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectAccessNotice } from "./ProjectAccessNotice";
import { agentsApi } from "../api/agents";
import { activityApi } from "../api/activity";

vi.mock("../lib/router", () => ({ Link: ({ to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => <a href={to} {...props} /> }));
vi.mock("../api/agents", () => ({ agentsApi: { getProjectAccess: vi.fn(), retryFailedRun: vi.fn() } }));
vi.mock("../api/activity", () => ({ activityApi: { runsForIssue: vi.fn() } }));

describe("project access notice", () => {
  let root: Root, container: HTMLDivElement, client: QueryClient;
  const onRetried = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.mocked(activityApi.runsForIssue).mockResolvedValue([{ runId: "run", agentId: "agent", status: "failed", errorCode: "low_trust_boundary_mismatch", createdAt: "2026-10-26T08:00:00Z" }] as never);
    vi.mocked(agentsApi.getProjectAccess).mockResolvedValue({ projectIds: [], canManage: true });
  });
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });

  async function render() {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ProjectAccessNotice companyId="company" issueId="task" projectId="project" assigneeAgentId="agent" onRetried={onRetried} />
    </QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }

  it("links the denied task to agent settings and waits for an explicit retry", async () => {
    let resolveAccess!: (value: Awaited<ReturnType<typeof agentsApi.getProjectAccess>>) => void;
    vi.mocked(agentsApi.getProjectAccess).mockReturnValue(new Promise(resolve => { resolveAccess = resolve; }));
    await render();
    expect(container.textContent).toContain("cannot access this task's project");
    expect(container.querySelector("a")).toBeNull();
    await act(async () => { resolveAccess({ projectIds: [], canManage: true }); });
    await vi.waitFor(() => expect(container.querySelector("a")?.getAttribute("href")).toBe("/agents/agent/permissions"));
    expect(agentsApi.retryFailedRun).not.toHaveBeenCalled();
  });

  it("offers a retry only after the current boundary allows the project", async () => {
    vi.mocked(agentsApi.getProjectAccess).mockResolvedValue({ projectIds: ["project"], canManage: true });
    vi.mocked(agentsApi.retryFailedRun).mockResolvedValue({} as never);
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("Project access is saved"));
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(agentsApi.retryFailedRun).toHaveBeenCalledWith("agent", "run", "company");
    expect(onRetried).toHaveBeenCalledOnce();
  });

  it("hides an old denial after a newer run begins", async () => {
    vi.mocked(activityApi.runsForIssue).mockResolvedValue([
      { runId: "old", agentId: "agent", status: "failed", errorCode: "low_trust_boundary_mismatch", createdAt: "2026-10-26T08:00:00Z" },
      { runId: "new", agentId: "agent", status: "running", createdAt: "2026-10-26T08:01:00Z" },
    ] as never);
    await render();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});
