// @vitest-environment jsdom

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WEEKLY_REPORT_FIXTURE } from "../lib/weekly-report.fixture";
import { WeeklyReport, weeklyReportText } from "./WeeklyReport";

const api = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("../api/weeklyReport", () => ({ weeklyReportApi: { get: api.get } }));
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
  });

  it("copies as plain text for an email", () => {
    const text = weeklyReportText(WEEKLY_REPORT_FIXTURE);
    expect(text.startsWith("This week at Greatstone (12 Oct to 19 Oct)")).toBe(true);
    expect(text).toContain("What is stuck\n- GRE-4 Pipedrive import, stuck for 9 days (Ridge)");
    expect(text).toContain("Ridge: 2 tasks\n  GRE-1 Booking page");
  });
});
