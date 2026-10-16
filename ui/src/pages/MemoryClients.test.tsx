// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryGraphNode } from "@greatstone/shared";
import { ApiError } from "../api/client";
import { MemoryClientDetail, MemoryClients, groupClientMemory } from "./MemoryClients";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const graphApiMock = vi.hoisted(() => ({
  scopes: vi.fn(),
  createScope: vi.fn(),
  graph: vi.fn(),
}));

vi.mock("../api/memoryGraph", () => ({ memoryGraphApi: graphApiMock }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "co-kestrel" }) }));
vi.mock("../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    useNavigate: actual.useNavigate,
    useParams: actual.useParams,
    Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  };
});

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/memory/clients" element={<MemoryClients />} />
            <Route path="/memory/clients/:scopeId" element={<MemoryClientDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  // Entries load once the client's scope is known.
  await flush();
  await flush();
}

const body = () => document.body.textContent ?? "";

const scopes = [
  { id: "scope-org", companyId: "co-kestrel", kind: "organization", name: "Greatstone", projectId: null, agentId: null, createdAt: "" },
  { id: "scope-kestrel", companyId: "co-kestrel", kind: "client", name: "Kestrel Works", projectId: null, agentId: null, createdAt: "" },
];

function node(id: string, status: MemoryGraphNode["status"], excerpt: string, updatedAt: string, sourceKind: string | null = null): MemoryGraphNode {
  return {
    id,
    scopeId: "scope-kestrel",
    scopeKind: "client",
    scopeName: "Kestrel Works",
    title: null,
    excerpt,
    status,
    entryType: "observation",
    decisionClass: "operational",
    contributor: { actorType: "user", agentId: null, userId: "u1", name: null },
    source: { kind: sourceKind, id: sourceKind ? "src" : null, runId: null },
    openConflictCount: 0,
    createdAt: updatedAt,
    updatedAt,
  } as MemoryGraphNode;
}

const nodes = [
  node("n1", "approved", "Pays invoices within 30 days.", "2026-10-10T00:00:00Z"),
  node("n2", "approved", "Main contact is Priya in finance.", "2026-10-12T00:00:00Z", "chatgpt_import"),
  node("n3", "unreviewed", "Wants a monthly report.", "2026-10-14T00:00:00Z"),
  node("n4", "superseded", "Pays invoices within 60 days.", "2026-09-01T00:00:00Z"),
];

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  graphApiMock.scopes.mockResolvedValue(scopes);
  graphApiMock.graph.mockResolvedValue({ nodes, edges: [], truncated: false });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("groupClientMemory", () => {
  it("puts confirmed entries first, newest first, and leaves out replaced ones", () => {
    const groups = groupClientMemory(nodes, "");
    expect(groups.confirmed.map((entry) => entry.id)).toEqual(["n2", "n1"]);
    expect(groups.waiting.map((entry) => entry.id)).toEqual(["n3"]);
    expect(groupClientMemory(nodes, "priya").confirmed.map((entry) => entry.id)).toEqual(["n2"]);
  });
});

describe("MemoryClients", () => {
  it("lists only client scopes and adds a new client", async () => {
    graphApiMock.createScope.mockResolvedValue({ ...scopes[1], id: "scope-new", name: "Heron Ltd" });
    await renderAt("/memory/clients");
    const links = [...document.querySelectorAll('[aria-label="Clients"] a')];
    expect(links.map((link) => link.textContent)).toEqual([expect.stringContaining("Kestrel Works")]);
    expect(links[0].getAttribute("href")).toBe("/memory/clients/scope-kestrel");

    const input = document.querySelector('input[aria-label="Client name"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "Heron Ltd");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => (document.querySelector('button[type="submit"]') as HTMLButtonElement).click());
    await flush();
    expect(graphApiMock.createScope).toHaveBeenCalledWith("co-kestrel", { kind: "client", name: "Heron Ltd" });
  });

  it("says plainly when someone cannot add a client", async () => {
    graphApiMock.createScope.mockRejectedValue(new ApiError("Forbidden", 403, null));
    await renderAt("/memory/clients");
    const input = document.querySelector('input[aria-label="Client name"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "Heron Ltd");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => (document.querySelector('button[type="submit"]') as HTMLButtonElement).click());
    await flush();
    expect(body()).toContain("Only the owner or an admin can add a client.");
  });
});

describe("MemoryClientDetail", () => {
  it("shows what GSAM remembers about the client, confirmed apart from waiting", async () => {
    await renderAt("/memory/clients/scope-kestrel");
    expect(graphApiMock.graph).toHaveBeenCalledWith("co-kestrel", { scopeId: "scope-kestrel", limit: 500 });
    expect(body()).toContain("What GSAM remembers about Kestrel Works");
    const confirmed = document.querySelector('section[aria-label="Confirmed"]')!.textContent;
    expect(confirmed).toContain("Confirmed (2)");
    expect(confirmed).toContain("From ChatGPT");
    expect(confirmed).not.toContain("60 days");
    expect(document.querySelector('section[aria-label="Waiting for review"]')!.textContent).toContain("Wants a monthly report.");
    const review = [...document.querySelectorAll("a")].find((link) => link.textContent === "Review 1 waiting")!;
    expect(review.getAttribute("href")).toBe("/memory/review?scope=scope-kestrel");
  });

  it("explains an empty client memory", async () => {
    graphApiMock.graph.mockResolvedValue({ nodes: [], edges: [], truncated: false });
    await renderAt("/memory/clients/scope-kestrel");
    expect(body()).toContain("GSAM does not remember anything about Kestrel Works yet.");
  });

  it("does not load entries for a client the person cannot see", async () => {
    await renderAt("/memory/clients/scope-missing");
    expect(body()).toContain("was not found, or you cannot see it");
    expect(graphApiMock.graph).not.toHaveBeenCalled();
  });
});
