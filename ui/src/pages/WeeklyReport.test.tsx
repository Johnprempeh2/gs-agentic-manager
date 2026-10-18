// @vitest-environment jsdom

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WEEKLY_REPORT_FIXTURE } from "../lib/weekly-report.fixture";
import { WeeklyReport, weeklyReportText } from "./WeeklyReport";
import { OPEN_ASK_EVEREST_EVENT, type OpenAskEverestDetail } from "../lib/ask-everest-events";

const api = vi.hoisted(() => ({ get: vi.fn(), listDigests: vi.fn() }));

const memoryApi = vi.hoisted(() => ({ activityCounts: vi.fn(), activity: vi.fn() }));

vi.mock("../api/weeklyReport", () => ({ weeklyReportApi: { get: api.get } }));
vi.mock("../api/memoryGraph", () => ({ memoryGraphApi: memoryApi }));
vi.mock("../api/agentDailyDigests", () => ({ agentDailyDigestsApi: { list: api.listDigests } }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "c1", selectedCompany: { id: "c1", name: "Greatstone", issuePrefix: "GRE" } }),
}));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));

async function flushReact() {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => {});
}

describe("WeeklyReport", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    api.get.mockResolvedValue(WEEKLY_REPORT_FIXTURE);
    memoryApi.activityCounts.mockRejectedValue(new Error("Memory is off"));
    memoryApi.activity.mockRejectedValue(new Error("Memory is off"));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <WeeklyReport />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await act(flushReact);
  }

  it("shows the week in plain words, section by section", async () => {
    await render();
    expect(api.get).toHaveBeenCalledWith("c1");
    expect(container.querySelector("h1")?.textContent).toBe("This week at Greatstone");
    expect(container.querySelector("[data-testid='weekly-report-headline']")?.textContent).toContain("The agents finished 3 tasks.");
    expect(container.querySelector("[data-testid='weekly-report-needs-you']")?.textContent).toContain("and 5 more");
    expect(container.querySelector("[data-testid='weekly-report-finished']")?.textContent).toContain("Ridge finished 2 tasks");
    expect(container.querySelector("[data-testid='weekly-report-stuck']")?.textContent).toContain("stuck for 9 days, with Ridge");
    expect(container.querySelector("[data-testid='weekly-report-pipeline']")?.textContent).toContain("Acme: Proposal to Won (Client journey)");
    expect(container.querySelector("[data-testid='weekly-report-costs']")?.textContent).toContain("$13.00");
    expect(container.querySelector("[data-testid='weekly-report-memory']")).toBeNull();
  });

  it("says what GSAM learned this week", async () => {
    const status = (approved: number, unreviewed: number) => ({ approved, unreviewed, disputed: 0, superseded: 0, deleted: 0 });
    memoryApi.activityCounts.mockResolvedValue({
      note: "",
      contributors: [
        { contributor: {}, contributionCount: 3, contributionCountByStatus: status(2, 1), relationshipsStatedCount: 0, reviewActionCount: 0 },
        { contributor: {}, contributionCount: 1, contributionCountByStatus: status(1, 0), relationshipsStatedCount: 0, reviewActionCount: 0 },
      ],
    });
    memoryApi.activity.mockResolvedValue({
      items: [{ record: { id: "m1", title: null, content: "Acme pays within 30 days.", deletedAt: null }, scopeName: "Acme" }],
      nextCursor: null,
    });
    await render();
    expect(memoryApi.activityCounts).toHaveBeenCalledWith("c1", { from: "2026-10-12T07:00:00.000Z" });
    expect(memoryApi.activity).toHaveBeenCalledWith("c1", { from: "2026-10-12T07:00:00.000Z", status: "approved" });
    const section = container.querySelector("[data-testid='weekly-report-memory']")!;
    expect(section.textContent).toContain("4 new entries this week. 3 confirmed, 1 waiting for review.");
    expect(section.textContent).toContain("Acme pays within 30 days.");
    expect([...section.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toContain("/GRE/memory?node=m1");
    expect(section.textContent).toContain("Review 1 waiting");
  });

  it("opens Ask Everest about this report", async () => {
    await render();
    const opened: OpenAskEverestDetail[] = [];
    const listener = (event: Event) => opened.push((event as CustomEvent<OpenAskEverestDetail>).detail);
    window.addEventListener(OPEN_ASK_EVEREST_EVENT, listener);
    act(() => (container.querySelector("[data-testid='weekly-report-ask']") as HTMLButtonElement).click());
    window.removeEventListener(OPEN_ASK_EVEREST_EVENT, listener);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.context?.label).toBe("This week at Greatstone");
    expect(opened[0]!.context?.summary).toContain("GRE-4 Pipedrive import, stuck for 9 days");
    expect(opened[0]!.context?.suggestions).toContain("What should I focus on this week?");
  });

  it("shares the report from the phone's share sheet", async () => {
    const nav = navigator as unknown as { share?: (data: ShareData) => Promise<void> };
    const share = vi.fn(async () => {});
    nav.share = share;
    try {
      await render();
      const button = [...container.querySelectorAll("button")].find((b) => b.textContent === "Share");
      await act(async () => button!.click());
      expect(share).toHaveBeenCalledWith(expect.objectContaining({ title: "This week at Greatstone", text: expect.stringContaining("Pipedrive import") }));
    } finally {
      delete nav.share;
    }
  });

  it("says the day by day view starts after the first night", async () => {
    await render();
    expect(container.querySelector("[data-testid='weekly-report-daily']")?.textContent).toContain(
      "The first nightly digest is written just after midnight (UTC).",
    );
    expect(api.listDigests).not.toHaveBeenCalled();
  });

  it("shows each stored nightly digest, with each agent's part and the lead agent's task", async () => {
    const counts = { tasksCompleted: 2, tasksMoved: 1, comments: 3, runs: 5, failures: 1, spendCents: 250 };
    api.get.mockResolvedValue({
      ...WEEKLY_REPORT_FIXTURE,
      daily: [
        { date: "2026-10-15", tasksCompleted: 2, tasksMoved: 1, comments: 3, runs: 5, failures: 1, spendCents: 250, busiestAgent: "Ridge" },
        { date: "2026-10-16", tasksCompleted: 0, tasksMoved: 0, comments: 0, runs: 0, failures: 0, spendCents: 0, busiestAgent: null },
      ],
    });
    api.listDigests.mockResolvedValue({
      from: "2026-10-15",
      to: "2026-10-16",
      digests: [
        {
          id: "d1",
          companyId: "c1",
          date: "2026-10-15",
          body: "",
          leadAgentId: "a9",
          deliveredIssueId: "i9",
          deliveredIssueIdentifier: "GRE-40",
          deliveredAt: "2026-10-16T00:10:00.000Z",
          skippedReason: null,
          createdAt: "2026-10-16T00:10:00.000Z",
          payload: {
            date: "2026-10-15",
            windowStart: "2026-10-15T00:00:00.000Z",
            windowEnd: "2026-10-16T00:00:00.000Z",
            totals: counts,
            agents: [{ agentId: "a1", name: "Ridge", counts, completed: [], moved: [], failed: [] }],
          },
        },
      ],
    });
    await render();
    expect(api.listDigests).toHaveBeenCalledWith("c1", { from: "2026-10-15", to: "2026-10-16" });
    const section = container.querySelector("[data-testid='weekly-report-daily']")!;
    const text = section.textContent ?? "";
    expect(text).toContain("15 Oct: 2 finished, 1 moved, 3 comments, 5 runs (1 failed), $2.50. Busiest: Ridge.");
    expect(text).toContain("16 Oct: 0 finished, 0 moved, 0 comments, 0 runs, $0.00.");
    expect(section.querySelector("details li")?.textContent).toBe("Ridge: 2 finished, 1 moved, 3 comments, 5 runs (1 failed), $2.50.");
    expect(section.querySelector("a[href$='/issues/GRE-40']")?.textContent).toBe("GRE-40");
  });

  it("copies as plain text for an email", () => {
    const text = weeklyReportText(WEEKLY_REPORT_FIXTURE);
    expect(text.startsWith("This week at Greatstone (12 Oct to 19 Oct)")).toBe(true);
    expect(text).toContain("What is stuck\n- GRE-4 Pipedrive import, stuck for 9 days (Ridge)");
    expect(text).toContain("Ridge: 2 tasks\n  GRE-1 Booking page");
  });
});
