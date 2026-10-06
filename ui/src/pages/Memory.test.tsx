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
  confirmLead: vi.fn(),
  dismissLead: vi.fn(),
}));

vi.mock("../api/memoryGraph", () => ({ memoryGraphApi: memoryApiMock }));

// jsdom has no WebGL: stand in for the lazy three.js graph with plain buttons
// built from the same transformed data, and choose per test whether WebGL exists.
const webglMock = vi.hoisted(() => ({ supported: true }));
vi.mock("../lib/webgl", () => ({ supportsWebGL: () => webglMock.supported }));
vi.mock("../components/memory/MemoryGraph3D", () => ({
  default: ({
    data,
    onSelectNode,
    onSelectEdge,
  }: {
    data: import("../components/memory/memoryGraph3dData").MemoryGraph3DData;
    onSelectNode: (id: string) => void;
    onSelectEdge: (id: string) => void;
  }) => (
    <div data-testid="memory-graph-3d">
      {data.nodes.map((node) => (
        <button
          key={node.id}
          type="button"
          data-node-kind={node.kind}
          data-node-status={node.status ?? undefined}
          onClick={() => node.kind === "memory" && onSelectNode(node.id)}
        >
          {node.label}
        </button>
      ))}
      {data.links.map((link) => (
        <button
          key={link.id}
          type="button"
          data-link-style={link.style}
          data-edge-kind={link.edgeId ? (link.style === "stated" ? "explicit" : "inferred") : undefined}
          onClick={() => link.edgeId && onSelectEdge(link.edgeId)}
        />
      ))}
    </div>
  ),
}));
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
  leadId: null,
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

  it("keeps stated links, check findings and contributor links apart, and says so in the legend", async () => {
    await renderAt("/memory");

    expect(container.querySelectorAll('[data-link-style="stated"]')).toHaveLength(3);
    expect(container.querySelectorAll('[data-link-style="inferred"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-link-style="provenance"]')).toHaveLength(kestrelNodes.length);
    // Mason, Scribe and Everest each get one hub.
    expect(container.querySelectorAll('[data-node-kind="hub"]')).toHaveLength(3);
    const legend = container.querySelector("figcaption")?.textContent ?? "";
    expect(legend).toContain("Stated link");
    expect(legend).toContain("Found by a check");
    expect(legend).toContain("Contributed by");
    expect(legend).toContain(APPROVED_MEANING);
  });

  it("groups by scope when asked, without changing the server query", async () => {
    await renderAt("/memory?group=scope");

    const hubs = Array.from(container.querySelectorAll('[data-node-kind="hub"]')).map((hub) => hub.textContent);
    expect(hubs.sort()).toEqual(["Alder Bakery", "Alder website rebuild"]);
    expect(container.querySelector("figcaption")?.textContent).toContain("In scope");
    expect(memoryApiMock.graph).toHaveBeenCalledWith("co-kestrel", { q: undefined, agentId: undefined, scopeId: undefined, status: undefined });
  });

  it("falls back to the list with a note when WebGL is not available", async () => {
    webglMock.supported = false;
    try {
      await renderAt("/memory");
      expect(container.querySelector('[data-testid="memory-graph-3d"]')).toBeNull();
      expect(text()).toContain("The 3D graph needs WebGL");
      expect(container.querySelectorAll("button[data-memory-row]")).toHaveLength(kestrelNodes.length);
    } finally {
      webglMock.supported = true;
    }
  });

  it("switches to the list view and back", async () => {
    await renderAt("/memory");
    const listButton = Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="Memory view"] button')).find(
      (button) => button.textContent === "List",
    )!;
    await act(async () => listButton.click());
    await flush();
    expect(currentSearch).toContain("view=list");
    expect(container.querySelector('[data-testid="memory-graph-3d"]')).toBeNull();
    expect(container.querySelectorAll("button[data-memory-row]")).toHaveLength(kestrelNodes.length);
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

  it("opens a connection from the graph and explains it without implying cause", async () => {
    await renderAt("/memory");

    const edge = container.querySelector<HTMLButtonElement>('[data-edge-kind="inferred"]')!;
    await act(async () => edge.click());
    await flush();

    expect(currentSearch).toContain(`edge=${encodeURIComponent(conflictEdge.id)}`);
    const panel = container.querySelector('aside[aria-label="Connection details"]')!;
    expect(panel.textContent).toContain("Found by a check");
    expect(panel.textContent).toContain("Matched on: opening, 6am");
    expect(panel.textContent).toContain(kestrelGraph.note);
  });

  it("shows what the link check matched on a lead and lets a reviewer confirm it", async () => {
    const basis = { entities: ["alder bakery"], topics: [], values: ["7am"], sameSource: true };
    const leadEdge = {
      ...kestrelEdges[1],
      id: "lnk:lead-1",
      from: kestrelNodes[0].id,
      to: kestrelNodes[1].id,
      type: "same_subject" as const,
      kind: "inferred" as const,
      origin: "link_check" as const,
      author: kestrelAgents.check,
      source: { kind: "memory_link_lead", id: "lead-1", runId: null },
      basis,
    };
    memoryApiMock.graph.mockResolvedValue({ ...kestrelGraph, edges: [leadEdge] });
    memoryApiMock.edge.mockResolvedValue({
      ...conflictDetail,
      edge: leadEdge,
      meaning: "Both entries may be about the same subject.",
      from: kestrelNodes[0],
      to: kestrelNodes[1],
      sharedTerms: [],
      conflictState: null,
      leadId: "lead-1",
    } satisfies MemoryGraphEdgeDetail);
    memoryApiMock.confirmLead.mockResolvedValue({});
    await renderAt("/memory?edge=lnk%3Alead-1");
    await flush();

    const panel = container.querySelector('aside[aria-label="Connection details"]')!;
    expect(panel.textContent).toContain("Matched on:");
    expect(panel.textContent).toContain("Names: alder bakery");
    expect(panel.textContent).toContain("Stated values: 7am");
    expect(panel.textContent).toContain("Both came from the same source");
    expect(panel.textContent).toContain("Review this lead");

    const textarea = panel.querySelector("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, "Same bakery");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const confirm = Array.from(panel.querySelectorAll("button")).find((button) => button.textContent === "Confirm link")!;
    await act(async () => confirm.click());
    await flush();
    expect(memoryApiMock.confirmLead).toHaveBeenCalledWith("co-kestrel", "lead-1", { type: "same_subject", reason: "Same bakery" });
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
