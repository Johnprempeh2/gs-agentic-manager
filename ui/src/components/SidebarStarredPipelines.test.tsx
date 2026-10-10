// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ResourceMemberships } from "@greatstone/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineListItem } from "../api/pipelines";
import { SidebarStarredPipelines } from "./SidebarStarredPipelines";
import { TooltipProvider } from "@/components/ui/tooltip";

const mockPipelinesApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockInstanceSettingsApi = vi.hoisted(() => ({ getExperimental: vi.fn() }));
const mockResourceMembershipsApi = vi.hoisted(() => ({ listMine: vi.fn(), updatePipeline: vi.fn() }));
const mockLocation = vi.hoisted(() => ({ pathname: "/PAP/dashboard" }));

vi.mock("@/lib/router", () => ({
  NavLink: ({ children, className, to, state: _state, ...props }: {
    children: ReactNode;
    className?: string;
    to: string;
    state?: unknown;
  }) => (
    <a href={to} className={className} {...props}>
      {children}
    </a>
  ),
  useLocation: () => ({ pathname: mockLocation.pathname, search: "", hash: "", state: null }),
}));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", issuePrefix: "PAP" } }),
}));
vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn(), collapsed: false, peeking: false }),
}));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));
vi.mock("../api/pipelines", () => ({ pipelinesApi: mockPipelinesApi }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceSettingsApi }));
vi.mock("../api/resourceMemberships", () => ({ resourceMembershipsApi: mockResourceMembershipsApi }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function pipeline(id: string, name: string, archivedAt: string | null = null): PipelineListItem {
  return {
    id,
    companyId: "company-1",
    key: id,
    name,
    description: null,
    projectId: null,
    enforceTransitions: false,
    archivedAt,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  } as PipelineListItem;
}

describe("SidebarStarredPipelines", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let queryClient: QueryClient;
  let memberships: ResourceMemberships;

  beforeEach(() => {
    mockLocation.pathname = "/PAP/dashboard";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    memberships = {
      projectMemberships: {},
      agentMemberships: {},
      starredDocumentIds: [],
      documentStarredAt: {},
      starredPipelineIds: ["p-sales", "p-old", "p-hidden"],
      pipelineStarredAt: {},
      updatedAt: null,
    };
    mockResourceMembershipsApi.listMine.mockImplementation(() => Promise.resolve(memberships));
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enablePipelines: true });
    // p-hidden is starred but not in the list the viewer can see; p-other is visible but not starred.
    mockPipelinesApi.list.mockResolvedValue([
      pipeline("p-sales", "Sales"),
      pipeline("p-delivery", "Delivery"),
      pipeline("p-old", "Old", "2026-02-01T00:00:00Z"),
      pipeline("p-other", "Other"),
    ]);
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    queryClient.clear();
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <SidebarStarredPipelines />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  const links = () =>
    Array.from(container.querySelectorAll("a")).map((a) => [a.textContent?.trim(), a.getAttribute("href")]);

  it("shows only starred pipelines the viewer can see, sorted by name, linking to the pipeline", async () => {
    memberships.starredPipelineIds = ["p-sales", "p-old", "p-hidden", "p-delivery"];
    await render();

    expect(links()).toEqual([
      ["Delivery", "/pipelines/p-delivery"],
      ["Sales", "/pipelines/p-sales"],
    ]);
  });

  it("marks the open pipeline as the current page", async () => {
    mockLocation.pathname = "/PAP/pipelines/p-sales/items/case-1";
    await render();

    const sales = container.querySelector('a[href="/pipelines/p-sales"]');
    expect(sales?.getAttribute("aria-current")).toBe("page");
    expect(sales?.className).toContain("bg-sidebar-accent");
  });

  it("renders nothing and fetches nothing while enablePipelines is off", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enablePipelines: false });
    await render();

    expect(container.innerHTML).toBe("");
    expect(mockPipelinesApi.list).not.toHaveBeenCalled();
    expect(mockResourceMembershipsApi.listMine).not.toHaveBeenCalled();
  });

  it("unpins through the pipeline resource membership API", async () => {
    mockResourceMembershipsApi.updatePipeline.mockResolvedValue({
      resourceType: "pipeline",
      resourceId: "p-sales",
      state: "joined",
      starredAt: null,
      updatedAt: new Date(),
    });
    await render();

    const unstar = container.querySelector('button[aria-label="Unstar Sales"]') as HTMLButtonElement;
    await act(async () => unstar.click());
    await flushReact();

    expect(mockResourceMembershipsApi.updatePipeline).toHaveBeenCalledWith("company-1", "p-sales", { starred: false });
  });
});
