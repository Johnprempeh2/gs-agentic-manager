// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { AnchorHTMLAttributes } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deepDiveBrokenLinks, type DeepDiveTraceability as Chain } from "@greatstone/shared";
import { DeepDiveTraceability } from "./DeepDiveTraceability";

// Generic fixtures only: "Client company". Never a real client.
const COMPANY_ID = "company-1";

const store = vi.hoisted(() => ({ chain: null as unknown }));
const chain = () => store.chain as Chain;

/** A full chain from North Star to KPI. */
function fixture(): Chain {
  const links: Omit<Chain, "companyId" | "broken"> = {
    northStar: { documentId: "ns", words: "Same-day quotes for every customer" },
    sources: [{ id: "src", title: "Quote log" }],
    findings: [{ id: "f", statement: "Quotes take 8 days", status: "validated", sourceIds: ["src"] }],
    opportunities: [{ id: "o", name: "Faster quotes", findingIds: ["f"] }],
    designs: [{ id: "d", name: "Quote builder", state: "agreed", opportunityId: "o" }],
    commercials: [{ id: "c", name: "Fixed fee", terms: "Two payments", value: "", buildId: "d", visibility: "internal" }],
    roadmap: [{ id: "r", name: "Phase 1", phase: "Q1 2027", commercialId: "c", kpiIds: ["k"], visibility: "internal" }],
    kpis: [{ id: "k", name: "Days to quote" }],
  };
  return { companyId: COMPANY_ID, ...links, broken: deepDiveBrokenLinks(links) };
}

const mockApi = vi.hoisted(() => ({
  get: vi.fn(), addCommercial: vi.fn(), updateCommercial: vi.fn(), removeCommercial: vi.fn(),
  addRoadmapItem: vi.fn(), updateRoadmapItem: vi.fn(), removeRoadmapItem: vi.fn(),
}));

vi.mock("@/api/deepDiveTraceability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/deepDiveTraceability")>()),
  deepDiveTraceabilityApi: mockApi,
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: COMPANY_ID, selectedCompany: { id: COMPANY_ID, name: "Client company", issuePrefix: "C001" } }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => <a href={to} {...props}>{children}</a>,
}));

/** A fake server that keeps the chain between calls and runs the real broken-link check. */
function installFakeServer() {
  const copy = () => {
    const next = structuredClone(store.chain) as Chain;
    const { companyId: _c, broken: _b, ...links } = next;
    return { ...next, broken: deepDiveBrokenLinks(links) };
  };
  mockApi.get.mockImplementation(async () => copy());
  mockApi.removeCommercial.mockImplementation(async (id: string) => {
    chain().commercials = chain().commercials.filter((c) => c.id !== id);
    for (const item of chain().roadmap) if (item.commercialId === id) item.commercialId = null;
    return copy();
  });
  mockApi.addCommercial.mockImplementation(async (_companyId: string, input: { name: string; buildId?: string | null; terms?: string }) => {
    chain().commercials.push({ id: `c-${chain().commercials.length + 1}`, name: input.name, terms: input.terms ?? "", value: "", buildId: input.buildId ?? null, visibility: "internal" });
    return copy();
  });
  mockApi.updateRoadmapItem.mockImplementation(async (id: string, input: Record<string, unknown>) => {
    Object.assign(chain().roadmap.find((r) => r.id === id)!, input);
    return copy();
  });
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

async function waitFor(assertion: () => void, attempts = 40) {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = element.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
}

function button(container: HTMLElement, label: string) {
  const found = [...container.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === label);
  if (!found) throw new Error(`No button "${label}"`);
  return found;
}

const byLabel = <T extends Element>(container: HTMLElement, label: string) => {
  const found = container.querySelector<T>(`[aria-label="${label}"]`);
  if (!found) throw new Error(`Nothing labelled "${label}"`);
  return found;
};

describe("Deep Dive traceability", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    store.chain = fixture();
    vi.clearAllMocks();
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    installFakeServer();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    vi.unstubAllGlobals();
  });

  function render() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root.render(<QueryClientProvider client={queryClient}><DeepDiveTraceability /></QueryClientProvider>);
    });
  }

  const card = () => byLabel<HTMLElement>(container, "Chain through Faster quotes");
  const step = (name: string) => card().querySelector(`[data-chain-step="${name}"]`)!.textContent;

  it("shows every link of a full chain and no broken link", async () => {
    render();
    await waitFor(() => expect(container.textContent).toContain("Broken links (0)"));
    expect(container.textContent).toContain("No broken links. Every chain runs from the North Star to a KPI.");
    expect(card().textContent).toContain("Whole chain");
    expect(step("north_star")).toContain("Same-day quotes for every customer");
    expect(step("source")).toContain("Quote log");
    expect(step("design")).toContain("Quote builder");
    expect(step("commercial")).toContain("Fixed fee");
    expect(step("roadmap")).toContain("Phase 1");
    expect(step("kpi")).toContain("Days to quote");
  });

  it("marks where the chain breaks and lists the broken links when a commercial case is removed", async () => {
    render();
    await waitFor(() => expect(container.textContent).toContain("Broken links (0)"));
    flushSync(() => byLabel<HTMLButtonElement>(container, "Remove Fixed fee").click());
    await waitFor(() => expect(container.textContent).toContain("Broken links (2)"));
    expect(mockApi.removeCommercial).toHaveBeenCalledWith("c");
    const broken = byLabel<HTMLElement>(container, "Broken links").textContent;
    expect(broken).toContain("Quote builder: This design has no commercial case.");
    expect(broken).toContain("Phase 1: This roadmap item delivers no commercial case.");
    expect(card().textContent).toContain("Breaks at Commercial");
    expect(step("commercial")).toContain("Breaks here: nothing linked");
    expect(step("kpi")).toContain("Not reached");
  });

  it("adds a commercial case for a design and mends the chain", async () => {
    store.chain = { ...fixture(), commercials: [] };
    chain().roadmap[0]!.commercialId = null;
    render();
    await waitFor(() => expect(container.textContent).toContain("Broken links (2)"));
    flushSync(() => setValue(byLabel<HTMLInputElement>(container, "Commercial case name"), "Retainer"));
    flushSync(() => setValue(byLabel<HTMLSelectElement>(container, "Design it is for"), "d"));
    flushSync(() => button(container, "Add commercial case").click());
    // The design now has its case; the case is on no roadmap until Phase 1 delivers it.
    await waitFor(() => expect(byLabel<HTMLElement>(container, "Broken links").textContent).toContain("Retainer: This commercial case is on no roadmap."));
    expect(byLabel<HTMLElement>(container, "Broken links").textContent).not.toContain("This design has no commercial case.");
    expect(mockApi.addCommercial).toHaveBeenCalledWith(COMPANY_ID, { name: "Retainer", buildId: "d", terms: "" });

    flushSync(() => setValue(byLabel<HTMLSelectElement>(container, "Commercial case Phase 1 delivers"), "c-1"));
    await waitFor(() => expect(container.textContent).toContain("Broken links (0)"));
    expect(mockApi.updateRoadmapItem).toHaveBeenCalledWith("r", { commercialId: "c-1" });
    expect(card().textContent).toContain("Whole chain");
  });

  it("says there is no chain until there is an opportunity", async () => {
    store.chain = { ...fixture(), opportunities: [], designs: [], commercials: [], roadmap: [], kpis: [] };
    render();
    await waitFor(() => expect(container.textContent).toContain("No opportunities yet, so there is no chain."));
    expect(container.querySelector('a[href="/deep-dive/opportunities"]')).not.toBeNull();
  });
});
