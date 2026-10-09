// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineAccessMatrix } from "@greatstone/shared";
import { ToastProvider } from "@/context/ToastContext";
import { PipelineAgentAccessSection } from "./PipelineAgentAccessSection";
import { AgentPipelinesAccessSection } from "./AgentPipelinesAccessSection";
import { PipelineAccessOverview } from "@/pages/PipelineAccessOverview";
import { usePipelineAdminRights } from "@/hooks/usePipelineAccess";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockApi = vi.hoisted(() => ({ matrix: vi.fn(), setLevel: vi.fn() }));

vi.mock("@/api/pipelineAccess", () => ({ pipelineAccessApi: mockApi }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children?: ReactNode; to: string }) => <a href={to} {...props}>{children}</a>,
}));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));

const GRACE = { at: new Date().toISOString(), actorType: "user", actorId: "u1", actorName: "Grace" };
const ALAN = { at: new Date().toISOString(), actorType: "user", actorId: "u2", actorName: "Alan" };

function matrix(canManage: boolean): PipelineAccessMatrix {
  return {
    canManage,
    canCreatePipelines: canManage,
    administerPipelineIds: canManage ? ["p-sales"] : [],
    pipelines: [
      { id: "p-sales", name: "Sales", archivedAt: null },
      { id: "p-support", name: "Support", archivedAt: null },
      { id: "p-old", name: "Old", archivedAt: "2026-01-01T00:00:00.000Z" },
    ],
    agents: [
      {
        agentId: "a-harbor",
        name: "Harbor",
        role: "general",
        status: "idle",
        levels: { "p-sales": "administer", "p-support": "work_cases", "p-old": "view" },
        allPipelinesLevel: null,
        lastChange: ALAN,
        lastChanges: { "p-sales": GRACE, "p-support": ALAN, "p-old": null },
      },
      {
        agentId: "a-ridge",
        name: "Ridge",
        role: "general",
        status: "idle",
        levels: { "p-sales": "view", "p-support": "view", "p-old": "view" },
        allPipelinesLevel: "view",
        lastChange: null,
        lastChanges: { "p-sales": null, "p-support": null, "p-old": null },
      },
    ],
  };
}

describe("pipeline access views (GRE-1073)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockApi.matrix.mockReset();
    mockApi.setLevel.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(node: ReactNode) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ToastProvider>{node}</ToastProvider>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function select(label: string) {
    return container.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement | null;
  }

  async function choose(label: string, value: string) {
    const element = select(label)!;
    await act(async () => {
      element.value = value;
      element.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("pipeline view: a board admin changes an agent's level on this pipeline", async () => {
    mockApi.matrix.mockResolvedValue(matrix(true));
    mockApi.setLevel.mockResolvedValue(matrix(true));
    await render(<PipelineAgentAccessSection companyId="company-1" pipelineId="p-sales" pipelineName="Sales" />);

    expect(select("Harbor on Sales")?.value).toBe("administer");
    // Who changed this pipeline's grant, not the agent's latest change elsewhere.
    expect(container.textContent).toContain("Changed by Grace");
    expect(container.textContent).not.toContain("Changed by Alan");
    await choose("Ridge on Sales", "work_cases");
    expect(mockApi.setLevel).toHaveBeenCalledWith("company-1", "a-ridge", { level: "work_cases", pipelineId: "p-sales" });
  });

  it("pipeline view: viewers without the right see levels but no controls", async () => {
    mockApi.matrix.mockResolvedValue(matrix(false));
    await render(<PipelineAgentAccessSection companyId="company-1" pipelineId="p-sales" pipelineName="Sales" />);

    expect(container.querySelectorAll("select")).toHaveLength(0);
    expect(container.textContent).toContain("Administer");
    expect(container.textContent).toContain("Only owners who manage permissions");
  });

  it("agent view: sets all pipelines or one pipeline, and hides archived pipelines", async () => {
    mockApi.matrix.mockResolvedValue(matrix(true));
    mockApi.setLevel.mockResolvedValue(matrix(true));
    await render(<AgentPipelinesAccessSection companyId="company-1" agentId="a-harbor" agentName="Harbor" />);

    expect(select("Harbor on all pipelines")?.value).toBe("");
    expect(container.textContent).toContain("Levels differ by pipeline");
    expect(select("Harbor on Old")).toBeNull();
    const rows = [...container.querySelectorAll('ul[aria-label="Level per pipeline"] li')].map((li) => li.textContent);
    expect(rows[0]).toContain("Changed by Grace");
    expect(rows[1]).toContain("Changed by Alan");
    await choose("Harbor on Support", "view");
    expect(mockApi.setLevel).toHaveBeenLastCalledWith("company-1", "a-harbor", { level: "view", pipelineId: "p-support" });
    await choose("Harbor on all pipelines", "work_cases");
    expect(mockApi.setLevel).toHaveBeenLastCalledWith("company-1", "a-harbor", { level: "work_cases", pipelineId: undefined });
  });

  it("agent view: read-only for viewers without the right", async () => {
    mockApi.matrix.mockResolvedValue(matrix(false));
    await render(<AgentPipelinesAccessSection companyId="company-1" agentId="a-harbor" agentName="Harbor" />);
    expect(container.querySelectorAll("select")).toHaveLength(0);
    expect(container.textContent).toContain("Work cases");
  });

  it("overview: shows the matrix, filters by agent and pipeline, and edits a cell", async () => {
    mockApi.matrix.mockResolvedValue(matrix(true));
    mockApi.setLevel.mockResolvedValue(matrix(true));
    await render(<PipelineAccessOverview />);

    expect(select("Harbor on Sales")?.value).toBe("administer");
    expect(select("Ridge on Support")?.value).toBe("view");
    expect(select("Harbor on Old")).toBeNull();
    // Each cell carries its own last change.
    expect(select("Harbor on Sales")!.closest("td")!.textContent).toContain("Grace,");
    expect(select("Harbor on Support")!.closest("td")!.textContent).toContain("Alan,");

    const filter = container.querySelector('input[aria-label="Filter agents"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(filter, "rid");
      filter.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(select("Harbor on Sales")).toBeNull();
    expect(select("Ridge on Sales")).not.toBeNull();

    await choose("Filter pipelines", "p-support");
    expect(select("Ridge on Sales")).toBeNull();
    expect(select("Ridge on all pipelines")).toBeNull();

    await choose("Ridge on Support", "administer");
    expect(mockApi.setLevel).toHaveBeenCalledWith("company-1", "a-ridge", { level: "administer", pipelineId: "p-support" });
  });

  it("overview: no edit controls for viewers without the right", async () => {
    mockApi.matrix.mockResolvedValue(matrix(false));
    await render(<PipelineAccessOverview />);
    expect(container.querySelectorAll("table select")).toHaveLength(0);
    expect(container.textContent).toContain("Only owners who manage permissions can change levels.");
  });

  it("overview on a phone: one card per agent with every pipeline as a row", async () => {
    const matchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    try {
      mockApi.matrix.mockResolvedValue(matrix(true));
      await render(<PipelineAccessOverview />);
      expect(container.querySelector("table")).toBeNull();
      const cards = container.querySelectorAll('ul[aria-label="Agent access by pipeline"] > li');
      expect(cards).toHaveLength(2);
      expect(cards[0]!.textContent).toContain("Sales");
      expect(cards[0]!.textContent).toContain("Support");
      expect(cards[0]!.textContent).toContain("Changed by Alan");
      expect(select("Harbor on Support")?.value).toBe("work_cases");
      expect(select("Harbor on all pipelines")).not.toBeNull();
    } finally {
      window.matchMedia = matchMedia;
    }
  });

  it("pipeline admin rights: only pipelines the viewer administers", async () => {
    function Probe() {
      const rights = usePipelineAdminRights("company-1");
      return (
        <span data-testid="rights">
          {`${rights.canCreatePipelines}:${rights.canAdministerPipeline("p-sales")}:${rights.canAdministerPipeline("p-support")}`}
        </span>
      );
    }
    mockApi.matrix.mockResolvedValue(matrix(true));
    await render(<Probe />);
    expect(container.textContent).toBe("true:true:false");

    mockApi.matrix.mockResolvedValue(matrix(false));
    act(() => root.unmount());
    root = createRoot(container);
    await render(<Probe />);
    expect(container.textContent).toBe("false:false:false");
  });
});
