// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import { ClientMemoryPanel, findClientScope } from "./ClientMemoryPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const graphApiMock = vi.hoisted(() => ({ scopes: vi.fn(), graph: vi.fn(), createScope: vi.fn() }));
vi.mock("../../api/memoryGraph", () => ({ memoryGraphApi: graphApiMock }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

const scopes = [
  { id: "scope-org", companyId: "c1", kind: "organization", name: "Greatstone", projectId: null, agentId: null, createdAt: "" },
  { id: "scope-acme", companyId: "c1", kind: "client", name: "Acme  Ltd", projectId: null, agentId: null, createdAt: "" },
];

const node = (id: string, status: string, excerpt: string) => ({
  id,
  scopeId: "scope-acme",
  title: null,
  excerpt,
  status,
  updatedAt: `2026-10-1${id.slice(1)}T00:00:00Z`,
});

let container: HTMLDivElement;
let root: Root;

async function render(clientName: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ClientMemoryPanel companyId="c1" clientName={clientName} />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  graphApiMock.scopes.mockResolvedValue(scopes);
  graphApiMock.graph.mockResolvedValue({
    nodes: [node("n1", "approved", "Pays within 30 days."), node("n2", "unreviewed", "Wants a monthly report.")],
    edges: [],
    truncated: false,
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("findClientScope", () => {
  it("matches a client memory by name, ignoring case and spacing", () => {
    expect(findClientScope(scopes as never, "acme ltd")?.id).toBe("scope-acme");
    expect(findClientScope(scopes as never, "Greatstone")).toBeNull();
    expect(findClientScope(scopes as never, " ")).toBeNull();
  });
});

describe("ClientMemoryPanel", () => {
  it("shows what is confirmed about the client and links to its memory", async () => {
    await render("Acme Ltd");
    expect(graphApiMock.graph).toHaveBeenCalledWith("c1", { scopeId: "scope-acme", limit: 500 });
    const text = container.textContent ?? "";
    expect(text).toContain("What we remember");
    expect(text).toContain("Pays within 30 days.");
    expect(text).not.toContain("Wants a monthly report.");
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/memory/clients/scope-acme", "/memory/review?scope=scope-acme"]);
  });

  it("offers to start a memory for a new client", async () => {
    graphApiMock.createScope.mockRejectedValue(new ApiError("Forbidden", 403, null));
    await render("Heron");
    expect(container.textContent).toContain("GSAM does not keep a memory for Heron yet.");
    await act(async () => (container.querySelector("button") as HTMLButtonElement).click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(graphApiMock.createScope).toHaveBeenCalledWith("c1", { kind: "client", name: "Heron" });
    expect(container.textContent).toContain("Only the owner or an admin can start one.");
  });

  it("stays hidden when memory is off", async () => {
    graphApiMock.scopes.mockRejectedValue(new ApiError("Memory is not enabled", 404, null));
    await render("Acme Ltd");
    expect(container.querySelector("[data-testid='client-memory-panel']")).toBeNull();
  });
});
