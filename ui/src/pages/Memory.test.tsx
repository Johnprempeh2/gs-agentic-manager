// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryGraphEdgeDetail, MemoryGraphNodeDetail } from "@greatstone/shared";
import { ApiError } from "../api/client";
import { kestrelAgents, kestrelEdges, kestrelGraph, kestrelNodes } from "../fixtures/memoryKestrel";
import { APPROVED_MEANING, edgeTypeLabel } from "../components/memory/memoryLabels";
import { Memory } from "./Memory";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const memoryApiMock = vi.hoisted(() => ({
  graph: vi.fn(),
  node: vi.fn(),
  edge: vi.fn(),
  activity: vi.fn(),
  activityCounts: vi.fn(),
}));

vi.mock("../api/memoryGraph", () => ({ memoryGraphApi: memoryApiMock }));
vi.mock("../api/agents", () => ({ agentsApi: { list: vi.fn(async () => []) } }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "co-kestrel" }) }));
vi.mock("../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    useSearchParams: actual.useSearchParams,
    useNavigate: actual.useNavigate,
    Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  };
});

const hoursNode = kestrelNodes[0];

const hoursDetail: MemoryGraphNodeDetail = {
  node: hoursNode,
  record: {} as MemoryGraphNodeDetail["record"],
  provenance: {
    contributor: { ...kestrelAgents.scribe, runId: "run-scribe", at: hoursNode.createdAt },
    reviewers: [
      {
        action: "approve",
        actor: { ...kestrelAgents.john, name: null },
        runId: null,
        fromStatus: "unreviewed",
        toStatus: "approved",
        reason: "Checked with the bakery.",
        relatedRecordId: null,
        at: "2026-10-04T09:00:00.000Z",
      },
    ],
    checks: [],
    extraction: {
      facts: [
        {
          id: "fact-1",
          recordId: hoursNode.id,
          engineUnitId: "unit-1",
          factType: "world",
          contributorAgentId: "ag-scribe-syn",
          contributorUserId: null,
          firstSeenAt: "2026-10-03T10:05:00.000Z",
          lastSeenAt: "2026-10-03T10:05:00.000Z",
        },
      ],
    },
  },
  chain: [kestrelNodes[1], hoursNode],
  edges: kestrelEdges.filter((edge) => edge.from === hoursNode.id || edge.to === hoursNode.id),
  neighbours: kestrelNodes.filter((node) => node.id !== hoursNode.id),
};

const conflictEdge = kestrelEdges[3];
const conflictDetail: MemoryGraphEdgeDetail = {
  note: kestrelGraph.note,
  edge: conflictEdge,
  meaning: "The first entry may conflict with the approved second entry.",
  from: kestrelNodes[2],
  to: hoursNode,
  statedNote: null,
  sharedTerms: ["opening", "6am"],
  conflictState: "open",
};

let container: HTMLDivElement;
let root: Root;
let currentSearch = "";

function LocationProbe() {
  currentSearch = useLocation().search;
  return null;
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderAt(path: string) {
  act(() => root.unmount());
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/memory" element={<><Memory /><LocationProbe /></>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}

function text() {
  return container.textContent ?? "";
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  memoryApiMock.graph.mockResolvedValue(kestrelGraph);
  memoryApiMock.node.mockResolvedValue(hoursDetail);
  memoryApiMock.edge.mockResolvedValue(conflictDetail);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("Memory page", () => {
  it("shows the graph and the list from the same permitted data", async () => {
    await renderAt("/memory");

    const rows = container.querySelectorAll("button[data-memory-row]");
    expect(rows).toHaveLength(kestrelNodes.length);
    expect(container.querySelectorAll("[data-node-status]")).toHaveLength(kestrelNodes.length);
    expect(container.querySelectorAll("[data-edge-kind]")).toHaveLength(kestrelEdges.length);
    for (const label of ["Unreviewed", "Approved", "Disputed", "Superseded"]) {
      expect(text()).toContain(label);
    }
    expect(text()).toContain(kestrelGraph.note);
  });

  it("draws stated links solid with an arrow and check findings dashed without one", async () => {
    await renderAt("/memory");

    const inferred = container.querySelector('[data-edge-kind="inferred"] line:last-of-type')!;
    const explicit = container.querySelector('[data-edge-kind="explicit"] line:last-of-type')!;
    expect(inferred.getAttribute("stroke-dasharray")).toBe("5 4");
    expect(inferred.getAttribute("marker-end")).toBeNull();
    expect(explicit.getAttribute("stroke-dasharray")).toBeNull();
    expect(explicit.getAttribute("marker-end")).toMatch(/^url\(#memory-arrow-/);
    expect(container.querySelector("figcaption")?.textContent).toContain(APPROVED_MEANING);
  });

  it("passes filters from the URL to the server and does not filter on the client", async () => {
    memoryApiMock.graph.mockResolvedValue({ ...kestrelGraph, nodes: [kestrelNodes[3]], edges: [] });
    await renderAt("/memory?status=disputed&scope=pj-alder-site&agent=ag-everest-syn&q=launch");

    expect(memoryApiMock.graph).toHaveBeenCalledWith("co-kestrel", {
      q: "launch",
      agentId: "ag-everest-syn",
      scopeId: "pj-alder-site",
      status: "disputed",
    });
    expect(container.querySelectorAll("button[data-memory-row]")).toHaveLength(1);
  });

  it("selects an entry from the list and keeps contributor, reviewers and engine extraction apart", async () => {
    await renderAt("/memory");

    const row = Array.from(container.querySelectorAll<HTMLButtonElement>("button[data-memory-row]")).find((button) =>
      button.textContent?.includes("opens at 6am"),
    )!;
    await act(async () => row.click());
    await flush();

    expect(currentSearch).toContain("node=rec-hours");
    expect(memoryApiMock.node).toHaveBeenCalledWith("co-kestrel", "rec-hours");
    const panel = container.querySelector('aside[aria-label="Memory details"]')!;
    const sections = Array.from(panel.querySelectorAll("section")).map((section) => section.querySelector("h3")?.textContent);
    expect(sections).toEqual(["Contributor", "Reviewers and editors", "Engine extraction", "Supersession history", "Connections"]);
    expect(panel.textContent).toContain("Scribe (synthetic)");
    expect(panel.textContent).toContain("Approved by A board member");
    expect(panel.textContent).toContain("1 fact extracted by the engine");
  });

  it("opens a connection with the keyboard and explains it without implying cause", async () => {
    await renderAt("/memory");

    const edge = container.querySelector<SVGGElement>('[data-edge-kind="inferred"]')!;
    await act(async () => {
      edge.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();

    expect(currentSearch).toContain(`edge=${encodeURIComponent(conflictEdge.id)}`);
    const panel = container.querySelector('aside[aria-label="Connection details"]')!;
    expect(panel.textContent).toContain("Found by a check");
    expect(panel.textContent).toContain("Matched on: opening, 6am");
    expect(panel.textContent).toContain(kestrelGraph.note);
  });

  it("opens an entry linked from elsewhere even when the current filters hide it", async () => {
    memoryApiMock.graph.mockResolvedValue({ ...kestrelGraph, nodes: [kestrelNodes[3]], edges: [] });
    await renderAt("/memory?status=disputed&node=rec-hours");

    await flush();
    expect(memoryApiMock.node).toHaveBeenCalledWith("co-kestrel", "rec-hours");
    expect(container.querySelector('aside[aria-label="Memory details"]')?.textContent).toContain("opens at 6am");
  });

  it("shows a clear empty state, and a different one when filters match nothing", async () => {
    memoryApiMock.graph.mockResolvedValue({ ...kestrelGraph, nodes: [], edges: [] });
    await renderAt("/memory");
    expect(text()).toContain("No memory yet.");

    await renderAt("/memory?status=approved");
    expect(text()).toContain("No memory matches these filters.");
  });

  it("shows restricted and memory-off states instead of an error", async () => {
    memoryApiMock.graph.mockRejectedValue(new ApiError("Forbidden", 403, null));
    await renderAt("/memory");
    expect(text()).toContain("You do not have access to memory in this organization.");
    expect(container.querySelector("[data-memory-row]")).toBeNull();

    memoryApiMock.graph.mockRejectedValue(new ApiError("Memory is not enabled for this company", 404, null));
    await renderAt("/memory");
    expect(text()).toContain("Memory is turned off for this organization.");
  });
});

describe("memory labels", () => {
  it("never use causal words for a connection", () => {
    for (const label of Object.values(edgeTypeLabel)) {
      expect(label).not.toMatch(/caus|because|led to|result|proves?/i);
    }
  });
});
