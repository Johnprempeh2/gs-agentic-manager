// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { AnchorHTMLAttributes } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEEP_DIVE_STREAMS,
  defaultDeepDiveStreamFields,
  deepDiveOverview,
  type DeepDiveOverviewInput,
} from "@greatstone/shared";
import { DeepDiveOverview } from "./DeepDiveOverview";

// Generic fixtures only: "Client company". Never a real client.
const COMPANY_ID = "company-1";

const mockApi = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/api/deepDiveOverview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/deepDiveOverview")>()),
  deepDiveOverviewApi: mockApi,
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: COMPANY_ID, selectedCompany: { id: COMPANY_ID, name: "Client company", issuePrefix: "C001" } }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => <a href={to} {...props}>{children}</a>,
}));

/** A record under way: one Indicated cell, one proposed finding, a planned session. Built by the real rules. */
function input(): DeepDiveOverviewInput {
  return {
    now: new Date("2026-10-25T12:00:00Z"),
    recordExists: true,
    northStarWords: "Same-day quotes for every customer",
    clientChosen: true,
    streams: DEEP_DIVE_STREAMS.map((stream) => {
      const fields = defaultDeepDiveStreamFields(stream.key);
      for (const key of Object.keys(fields.knowledge) as (keyof typeof fields.knowledge)[]) fields.knowledge[key] = "known";
      return { caseId: `case-${stream.key}`, fields: { ...fields, status: "examined" as const } };
    }),
    findings: [{
      id: "f",
      statement: "Two people approve every quote",
      status: "proposed",
      streamCaseId: "case-operations",
      gifKey: "current-state",
      createdAt: "2026-10-24T09:00:00Z",
    }],
    sessions: [{
      id: "s1",
      companyId: COMPANY_ID,
      title: "Operations walk-through",
      status: "planned",
      visibility: "internal",
      plannedFor: "2026-11-02T09:00:00Z",
      startedAt: null,
      closedAt: null,
      createdAt: "2026-10-20T09:00:00Z",
      questionCount: 6,
      answeredCount: 0,
    }],
    documentRequests: [{ id: "r", title: "Quote log", held: false }],
    findingIdsInOpportunities: [],
    brokenLinkCount: 0,
    unplacedPeopleCount: 0,
  };
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

const byLabel = (container: HTMLElement, label: string) => {
  const found = container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (!found) throw new Error(`Nothing labelled "${label}"`);
  return found;
};

describe("Deep Dive overview", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
  });

  function render() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root.render(<QueryClientProvider client={queryClient}><DeepDiveOverview /></QueryClientProvider>);
    });
  }

  it("leads with what is next and links each step to its screen", async () => {
    const values = input();
    values.streams[0]!.fields.knowledge.evidence = "indicated";
    mockApi.get.mockResolvedValue(deepDiveOverview(COMPANY_ID, values));
    render();

    await waitFor(() => expect(container.textContent).toContain("What is next"));
    const steps = [...byLabel(container, "What is next").querySelectorAll("li a")].map((a) => [a.textContent, a.getAttribute("href")]);
    expect(steps).toEqual([
      ["Decide 1 proposed finding", "/deep-dive/findings"],
      ["Validate 1 indicated cell", "/deep-dive"],
      ["Chase 1 document asked of the client", "/deep-dive/files"],
    ]);
    expect(byLabel(container, "Needs a person").textContent).toContain("Decide 1 proposed finding");
    expect(byLabel(container, "Needs a person").textContent).not.toContain("Chase");
    expect(mockApi.get).toHaveBeenCalledWith(COMPANY_ID);
  });

  it("shows progress by stream, the next session and the open findings", async () => {
    const values = input();
    values.streams[0]!.fields.knowledge.evidence = "indicated";
    mockApi.get.mockResolvedValue(deepDiveOverview(COMPANY_ID, values));
    render();

    await waitFor(() => expect(container.textContent).toContain("Progress by stream"));
    expect(container.textContent).toContain("44 of 45 GIF cells Known · 1 Indicated · 0 Unknown");
    expect(byLabel(container, "Progress by stream").querySelectorAll("li")).toHaveLength(9);
    expect(byLabel(container, "Leadership: 4 Known, 1 Indicated, 0 Unknown")).toBeTruthy();
    expect(container.querySelector('[data-stream="operations"]')!.textContent).toContain("1 proposed");

    const session = container.querySelector('a[href="/deep-dive/sessions/s1"]');
    expect(session?.textContent).toBe("Operations walk-through");
    expect(container.textContent).toContain("0 of 6 questions answered");

    expect(byLabel(container, "Open findings").textContent).toContain("Two people approve every quote");
    expect(byLabel(container, "Open findings").textContent).toContain("Operations · Current state");
  });

  it("says nothing waits when every rule is met", async () => {
    const values = { ...input(), findings: [], sessions: [], documentRequests: [] };
    mockApi.get.mockResolvedValue(deepDiveOverview(COMPANY_ID, values));
    render();

    await waitFor(() => expect(container.textContent).toContain("Nothing waits. Every stream is Known"));
    expect(container.textContent).toContain("Nothing waits for a person.");
    expect(container.textContent).toContain("No session is planned.");
    expect(container.textContent).toContain("No finding waits for a decision.");
  });

  it("shows the error with a next step when the overview does not load", async () => {
    mockApi.get.mockRejectedValue(new Error("Deep Dive is off"));
    render();
    await waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toBe("Deep Dive is off Reload the page to try again."));
  });
});
