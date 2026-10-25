// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { AnchorHTMLAttributes } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeepDiveOpportunityBoard } from "@greatstone/shared";
import { DeepDiveOpportunities } from "./DeepDiveOpportunities";

// Generic fixtures only: "Client company". Never a real client.
const COMPANY_ID = "company-1";

const store = vi.hoisted(() => ({ board: null as unknown }));
const board = () => store.board as DeepDiveOpportunityBoard;

function fixture(): DeepDiveOpportunityBoard {
  return {
    companyId: COMPANY_ID,
    opportunities: [
      {
        id: "o-quotes", ref: "", name: "Faster quotes", statement: "", rootCause: "", desiredOutcome: "A quote goes out the same day",
        potentialValue: "", state: "draft", findingIds: ["f-old"], visibility: "internal",
      },
    ],
    builds: [
      { id: "b-builder", ref: "", name: "Quote builder", what: "", opportunityId: "o-quotes", state: "proposed", stateWhy: "", visibility: "internal" },
      { id: "b-loose", ref: "", name: "Inbox triage", what: "", opportunityId: null, state: "proposed", stateWhy: "", visibility: "internal" },
    ],
    kpis: [],
    findings: [
      { id: "f-old", statement: "Quotes take 9 days", status: "superseded", streamTitle: "Deep dive: Operations" },
      { id: "f-days", statement: "Quotes take 8 days", status: "validated", streamTitle: "Deep dive: Operations" },
      { id: "f-retype", statement: "Prices retyped twice", status: "validated", streamTitle: "Deep dive: Operations" },
    ],
    processes: [{ id: "pr-price", name: "Pricing" }, { id: "pr-quote", name: "Quoting" }],
    people: [{ id: "p-ama", name: "Ama" }],
  };
}

const mockApi = vi.hoisted(() => ({
  get: vi.fn(), addOpportunity: vi.fn(), updateOpportunity: vi.fn(), removeOpportunity: vi.fn(),
  addBuild: vi.fn(), updateBuild: vi.fn(), removeBuild: vi.fn(), addKpi: vi.fn(), updateKpi: vi.fn(), removeKpi: vi.fn(),
}));

vi.mock("@/api/deepDiveOpportunities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/deepDiveOpportunities")>()),
  deepDiveOpportunitiesApi: mockApi,
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: COMPANY_ID, selectedCompany: { id: COMPANY_ID, name: "Client company", issuePrefix: "C001" } }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => <a href={to} {...props}>{children}</a>,
}));

/** A fake server that keeps the board between calls, so the page shows what was saved. */
function installFakeServer() {
  const copy = () => structuredClone(store.board) as DeepDiveOpportunityBoard;
  mockApi.get.mockImplementation(async () => copy());
  mockApi.updateOpportunity.mockImplementation(async (id: string, input: Record<string, unknown>) => {
    Object.assign(board().opportunities.find((o) => o.id === id)!, input);
    return copy();
  });
  mockApi.addBuild.mockImplementation(async (_companyId: string, input: { name: string; opportunityId?: string | null }) => {
    board().builds.push({ id: `b-${board().builds.length + 1}`, ref: "", name: input.name, what: "", opportunityId: input.opportunityId ?? null, state: "proposed", stateWhy: "", visibility: "internal" });
    return copy();
  });
  mockApi.updateBuild.mockImplementation(async (id: string, input: Record<string, unknown>) => {
    Object.assign(board().builds.find((b) => b.id === id)!, input);
    return copy();
  });
  mockApi.addKpi.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => {
    board().kpis.push({
      id: `k-${board().kpis.length + 1}`, scope: "company", direction: "up", unit: "", processIds: [], visibility: "internal",
      ...(input as object),
    } as unknown as DeepDiveOpportunityBoard["kpis"][number]);
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

function setValue(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  const proto = element.tagName === "SELECT" ? HTMLSelectElement.prototype
    : element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
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

/** The checkbox for one option in a ticked list, found by the text of its label. */
function tick(scope: Element, text: string) {
  const label = [...scope.querySelectorAll("label")].find((entry) => entry.textContent?.startsWith(text));
  if (!label) throw new Error(`No option "${text}"`);
  return scope.querySelector<HTMLButtonElement>(`[id="${label.htmlFor}"]`)!;
}

describe("Deep Dive opportunities and KPIs", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    store.board = fixture();
    vi.clearAllMocks();
    // The Radix checkbox measures itself; jsdom has no ResizeObserver.
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
      root.render(<QueryClientProvider client={queryClient}>{<DeepDiveOpportunities />}</QueryClientProvider>);
    });
  }

  const findingsList = () => [...container.querySelectorAll("fieldset")].find((f) => f.querySelector("legend")?.textContent?.startsWith("Findings that point at Faster quotes"))!;

  it("shows each opportunity with the findings that point at it, its builds, and what is still to do", async () => {
    render();
    await waitFor(() => expect(container.textContent).toContain("Opportunities (1)"));
    const list = findingsList();
    // A finding linked before it was superseded stays listed and ticked.
    expect(list.textContent).toContain("Quotes take 9 days");
    expect(list.textContent).toContain("Superseded");
    expect(tick(list, "Quotes take 9 days").getAttribute("aria-checked")).toBe("true");
    expect(tick(list, "Quotes take 8 days").getAttribute("aria-checked")).toBe("false");
    expect(byLabel<HTMLElement>(container, "Builds for Faster quotes").textContent).toContain("Quote builder");
    expect(container.querySelector('[aria-labelledby="deep-dive-loose-builds"]')!.textContent).toContain("Inbox triage");
    expect(byLabel<HTMLElement>(container, "Still to do").textContent).toContain("1 build serves no opportunity");
  });

  it("saves the new set of findings when one is ticked", async () => {
    render();
    await waitFor(() => expect(container.textContent).toContain("Opportunities (1)"));
    flushSync(() => tick(findingsList(), "Quotes take 8 days").click());
    await waitFor(() => expect(mockApi.updateOpportunity).toHaveBeenCalledWith("o-quotes", { findingIds: ["f-old", "f-days"] }));
    await waitFor(() => expect(tick(findingsList(), "Quotes take 8 days").getAttribute("aria-checked")).toBe("true"));
    expect(findingsList().querySelector("legend")!.textContent).toContain("(2)");
  });

  it("adds a build to an opportunity and attaches a loose build to it", async () => {
    render();
    await waitFor(() => expect(container.textContent).toContain("Opportunities (1)"));
    flushSync(() => setValue(byLabel<HTMLInputElement>(container, "New build for Faster quotes"), "Price list sync"));
    flushSync(() => button(container, "Add build").click());
    await waitFor(() => expect(byLabel<HTMLElement>(container, "Builds for Faster quotes").textContent).toContain("Price list sync"));
    expect(mockApi.addBuild).toHaveBeenCalledWith(COMPANY_ID, { name: "Price list sync", opportunityId: "o-quotes" });

    flushSync(() => setValue(byLabel<HTMLSelectElement>(container, "Opportunity Inbox triage serves"), "o-quotes"));
    await waitFor(() => expect(mockApi.updateBuild).toHaveBeenCalledWith("b-loose", { opportunityId: "o-quotes" }));
    await waitFor(() => expect(byLabel<HTMLElement>(container, "Builds for Faster quotes").textContent).toContain("Inbox triage"));
    expect(container.querySelector('[aria-labelledby="deep-dive-loose-builds"]')).toBeNull();
  });

  it("waits for a reason before saving a tabled build", async () => {
    render();
    await waitFor(() => expect(container.textContent).toContain("Opportunities (1)"));
    flushSync(() => setValue(byLabel<HTMLSelectElement>(container, "State of Quote builder"), "tabled"));
    await flush();
    expect(mockApi.updateBuild).not.toHaveBeenCalled();
    expect(button(container, "Save reason").disabled).toBe(true);
    flushSync(() => setValue(byLabel<HTMLInputElement>(container, "Why Quote builder is tabled"), "Cost first"));
    flushSync(() => button(container, "Save reason").click());
    await waitFor(() => expect(mockApi.updateBuild).toHaveBeenCalledWith("b-builder", { state: "tabled", stateWhy: "Cost first" }));
  });

  it("adds a KPI only with an owner, a baseline and a target, linked to processes", async () => {
    render();
    await waitFor(() => expect(container.textContent).toContain("KPIs (0)"));
    const add = button(container, "Add KPI");
    flushSync(() => setValue(byLabel<HTMLInputElement>(container, "KPI name"), "Days to quote"));
    flushSync(() => setValue(byLabel<HTMLInputElement>(container, "Baseline"), "8.4"));
    flushSync(() => setValue(byLabel<HTMLInputElement>(container, "Target"), "1"));
    flushSync(() => setValue(byLabel<HTMLTextAreaElement>(container, "How it is calculated"), "Mean working days"));
    flushSync(() => setValue(byLabel<HTMLInputElement>(container, "Period the baseline covers"), "Q3 2026"));
    expect(add.disabled).toBe(true); // no owner yet
    flushSync(() => setValue(byLabel<HTMLSelectElement>(container, "KPI owner"), "p-ama"));
    flushSync(() => setValue(byLabel<HTMLSelectElement>(container, "Which way is better"), "down"));
    const processes = [...container.querySelectorAll("fieldset")].find((f) => f.querySelector("legend")?.textContent === "Processes that move it")!;
    flushSync(() => tick(processes, "Quoting").click());
    expect(button(container, "Add KPI").disabled).toBe(false);
    flushSync(() => button(container, "Add KPI").click());

    await waitFor(() => expect(container.textContent).toContain("KPIs (1)"));
    expect(mockApi.addKpi).toHaveBeenCalledWith(COMPANY_ID, expect.objectContaining({
      name: "Days to quote", ownerPersonId: "p-ama", baseline: 8.4, target: 1, direction: "down",
      definition: "Mean working days", baselinePeriod: "Q3 2026", processIds: ["pr-quote"],
    }));
    const moved = [...container.querySelectorAll("fieldset")].find((f) => f.querySelector("legend")?.textContent?.startsWith("Processes that move Days to quote"))!;
    expect(tick(moved, "Quoting").getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).not.toContain("does not move this number the way it counts as better");
  });

  it("sends people to the organisation board when nobody can own a KPI", async () => {
    store.board = { ...fixture(), people: [] };
    render();
    await waitFor(() => expect(container.textContent).toContain("A KPI needs an owner."));
    expect(container.querySelector('a[href="/deep-dive/organisation"]')).not.toBeNull();
    expect([...container.querySelectorAll("button")].some((entry) => entry.textContent?.trim() === "Add KPI")).toBe(false);
  });
});
