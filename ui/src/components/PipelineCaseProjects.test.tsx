// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PipelineCaseProjects } from "./PipelineCaseProjects";
import { ProjectClientChips } from "./ProjectClientChips";

const mockPipelinesApi = vi.hoisted(() => ({
  getCaseProjectLinks: vi.fn(),
  linkCaseProject: vi.fn(),
  unlinkCaseProject: vi.fn(),
  listProjectCases: vi.fn(),
}));
const mockProjectsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("../api/pipelines", () => ({ pipelinesApi: mockPipelinesApi }));
vi.mock("../api/projects", () => ({ projectsApi: mockProjectsApi }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: mockPushToast }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

const omniLink = {
  link: { id: "link-1", companyId: "co-1", caseId: "case-1", projectId: "project-omni", createdAt: "", updatedAt: "" },
  project: { id: "project-omni", companyId: "co-1", name: "OMNI Group of Companies Africa", status: "in_progress", color: null },
  goals: [
    { id: "goal-1", title: "First client install", status: "active" },
    { id: "goal-2", title: "Ghana: three clients on signed terms", status: "active" },
  ],
};

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("client case project links UI", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  async function render(node: ReactNode) {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root!.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
    });
    await flushReact();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
  });

  it("lists the linked project and the goals that come through it", async () => {
    mockPipelinesApi.getCaseProjectLinks.mockResolvedValue([omniLink]);
    mockProjectsApi.list.mockResolvedValue([{ id: "project-omni", name: "OMNI Group of Companies Africa" }]);

    await render(<PipelineCaseProjects caseId="case-1" companyId="co-1" />);

    expect(container.textContent).toContain("OMNI Group of Companies Africa");
    expect(container.textContent).toContain("First client install");
    expect(container.textContent).toContain("Ghana: three clients on signed terms");
    expect(container.querySelector('a[href="/goals/goal-1"]')).not.toBeNull();
  });

  it("links a chosen project and unlinks a linked one", async () => {
    mockPipelinesApi.getCaseProjectLinks.mockResolvedValue([omniLink]);
    mockProjectsApi.list.mockResolvedValue([
      { id: "project-omni", name: "OMNI Group of Companies Africa" },
      { id: "project-indago", name: "Indago" },
    ]);
    mockPipelinesApi.linkCaseProject.mockResolvedValue({});
    mockPipelinesApi.unlinkCaseProject.mockResolvedValue({ deleted: true });

    await render(<PipelineCaseProjects caseId="case-1" companyId="co-1" />);

    const select = container.querySelector("select") as HTMLSelectElement;
    // Already-linked projects are not offered again.
    expect([...select.options].map((option) => option.value)).toEqual(["", "project-indago"]);
    flushSync(() => {
      select.value = "project-indago";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    flushSync(() => {
      (container.querySelector('button[type="submit"]') as HTMLButtonElement).click();
    });
    await flushReact();
    expect(mockPipelinesApi.linkCaseProject).toHaveBeenCalledWith("case-1", "project-indago");

    flushSync(() => {
      (container.querySelector('button[aria-label="Remove link to OMNI Group of Companies Africa"]') as HTMLButtonElement).click();
    });
    await flushReact();
    expect(mockPipelinesApi.unlinkCaseProject).toHaveBeenCalledWith("case-1", "project-omni");
  });

  it("shows a Client chip on the project that opens the case", async () => {
    mockPipelinesApi.listProjectCases.mockResolvedValue([
      {
        case: { id: "case-1", pipelineId: "pipe-1", caseKey: "omni", title: "OMNI" },
        pipeline: { id: "pipe-1", name: "Client journey" },
        stage: { id: "stage-3", key: "executive-discovery", name: "Executive Discovery", kind: "working" },
      },
    ]);

    await render(<ProjectClientChips projectId="project-omni" enabled />);

    const chip = container.querySelector('a[href="/pipelines/pipe-1/items/case-1"]');
    expect(chip?.textContent).toBe("ClientOMNI");
  });

  it("shows no chip and asks nothing when pipelines are off", async () => {
    await render(<ProjectClientChips projectId="project-omni" enabled={false} />);

    expect(container.innerHTML).toBe("");
    expect(mockPipelinesApi.listProjectCases).not.toHaveBeenCalled();
  });
});
