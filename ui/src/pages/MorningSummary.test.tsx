// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MorningSummary as Summary } from "@greatstone/shared";
import { MorningSummary, greeting, lateLabel } from "./MorningSummary";

const server = vi.hoisted(() => ({ summary: null as Summary | null, pausedUntil: null as string | null, windows: [] as string[] }));

vi.mock("../api/notificationPreferences", () => ({
  morningSummaryApi: { get: async (_companyId: string, window = "24h") => { server.windows.push(window); return server.summary; } },
  notificationPreferencesApi: {
    get: async () => ({ morningSummaryHour: 8, pausedUntil: server.pausedUntil }),
    update: async () => ({ morningSummaryHour: 8, pausedUntil: null }),
  },
}));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: null }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: () => {} }) }));

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
});
afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

async function render(path = "/morning") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <MorningSummary />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe("MorningSummary", () => {
  it("shows today so far when opened from the evening wrap-up", async () => {
    server.summary = {
      companyId: "company-1",
      generatedAt: "",
      since: "",
      needsYou: { count: 0, items: [] },
      dueToday: { count: 0, items: [] },
      finished: { count: 1, items: [{ id: "i1", identifier: "GRE-1", title: "Send the brief" }] },
      stuck: { count: 0, items: [] },
      dueTomorrow: { count: 1, items: [{ id: "i2", identifier: "GRE-2", title: "Board pack" }] },
    };
    server.windows = [];
    await render("/morning?window=day");
    expect(server.windows).toEqual(["day"]);
    expect(container.textContent).toContain("Finished today");
    expect(container.textContent).toContain("Due tomorrow");
    expect(container.textContent).toContain("Board pack");
    expect(container.textContent).toContain("what the team did today");
    expect(container.querySelector('a[href="/morning"]')?.textContent).toBe("Since yesterday");
    act(() => root?.unmount());

    server.windows = [];
    await render("/morning");
    expect(server.windows).toEqual(["24h"]);
    expect(container.textContent).toContain("Finished since yesterday");
    expect(container.querySelector('a[href="/morning?window=day"]')?.textContent).toBe("Today so far");
  });


  it("says when notifications are paused, and nothing when they are not", async () => {
    server.summary = {
      companyId: "company-1",
      generatedAt: "",
      since: "",
      needsYou: { count: 0, items: [] },
      dueToday: { count: 0, items: [] },
      finished: { count: 0, items: [] },
      stuck: { count: 0, items: [] },
    };
    server.pausedUntil = null;
    await render();
    expect(container.querySelector('[data-testid="notifications-paused"]')).toBeNull();
    act(() => root?.unmount());

    server.pausedUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await render();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.textContent).toContain("Notifications paused until");
    expect(container.textContent).toContain("Resume now");
    server.pausedUntil = null;
  });

  it("shows what needs you, what finished and what is stuck, with links to each task", async () => {
    server.summary = {
      companyId: "company-1",
      generatedAt: "",
      since: "",
      needsYou: { count: 5, items: [{ id: "a", identifier: "GRE-1", title: "Approve the brief" }] },
      dueToday: {
        count: 2,
        items: [
          { id: "c", identifier: "GRE-7", title: "Send the invoice", dueDate: "2020-01-02" },
          { id: "d", identifier: "GRE-8", title: "Call the printer", dueDate: "2999-01-01" },
        ],
      },
      finished: { count: 1, items: [{ id: "b", identifier: "GRE-5", title: "Write the one-pager" }] },
      stuck: { count: 0, items: [] },
      workingNow: { count: 1, items: [{ id: "w", identifier: "GRE-9", title: "Drafting the deck" }] },
      deals: { won: 1, lost: 0, items: [{ id: "c1", pipelineId: "p1", title: "Indago rollout", outcome: "won" }] },
      dealNextSteps: {
        count: 1,
        items: [{ id: "case-1", identifier: null, title: "Acme: Demo call", dueDate: "2020-01-03", href: "/pipelines/pipe-1/cases/case-1" }],
      },
    };
    await render();
    const deals = container.querySelector('[data-testid="morning-deals"]')!;
    expect(deals.textContent).toContain("1 won");
    expect(deals.querySelector('a[href="/pipelines/p1/cases/c1"]')?.textContent).toContain("Won");
    expect(container.textContent).toContain("Deal next steps due");
    expect(container.querySelector('a[href="/pipelines/pipe-1/cases/case-1"]')?.textContent).toContain("Acme: Demo call");
    expect(container.textContent).toContain("Working now");
    expect(container.querySelector('a[href="/issues/GRE-9"]')?.textContent).toContain("Drafting the deck");
    const text = container.textContent ?? "";
    expect(text).toContain("Approve the brief");
    expect(text).toContain("See all 5");
    expect(text).toContain("Write the one-pager");
    expect(text).toContain("Nothing is stuck.");
    expect(container.querySelector('a[href="/issues/GRE-1"]')).not.toBeNull();
    expect(text).toContain("Due today");
    expect(text).toContain("Late, due 2 Jan");
    expect(container.querySelector('a[href="/issues/GRE-8"]')?.textContent).not.toContain("Late");
  });

  it("still renders when the server sends no due today section", async () => {
    server.summary = {
      companyId: "company-1",
      generatedAt: "",
      since: "",
      needsYou: { count: 0, items: [] },
      finished: { count: 0, items: [] },
      stuck: { count: 0, items: [] },
    } as unknown as Summary;
    await render();
    expect(container.textContent).toContain("Nothing is due today.");
    expect(container.textContent).not.toContain("Deal next steps due");
  });

  it("marks lines due before today as late", () => {
    expect(lateLabel("2026-10-14", "2026-10-16")).toBe("Late, due 14 Oct");
    expect(lateLabel("2026-10-16", "2026-10-16")).toBeNull();
    expect(lateLabel(null, "2026-10-16")).toBeNull();
  });

  it("greets by the time of day", () => {
    expect(greeting(new Date(2026, 9, 16, 8))).toBe("Good morning");
    expect(greeting(new Date(2026, 9, 16, 14))).toBe("Good afternoon");
    expect(greeting(new Date(2026, 9, 16, 20))).toBe("Good evening");
  });
});
