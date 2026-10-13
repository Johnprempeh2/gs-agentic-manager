// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntelligenceReport } from "@greatstone/shared";
import { ApiError } from "../api/client";
import { Intelligence } from "./Intelligence";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiMock = vi.hoisted(() => ({
  report: vi.fn(),
  reports: vi.fn(),
  boards: vi.fn(),
  recommendations: vi.fn(),
  decide: vi.fn(),
  createTask: vi.fn(),
}));
const settingsMock = vi.hoisted(() => ({ getExperimental: vi.fn() }));

vi.mock("../api/intelligence", async () => {
  const actual = await vi.importActual<typeof import("../api/intelligence")>("../api/intelligence");
  const reportOrNull = async (companyId: string, date: string, kind: string) => {
    try {
      return await apiMock.report(companyId, date, kind);
    } catch (error) {
      if (error instanceof Error && (error as { status?: number }).status === 404) return null;
      throw error;
    }
  };
  return { ...actual, intelligenceApi: apiMock, reportOrNull };
});
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: settingsMock }));
vi.mock("../api/projects", () => ({ projectsApi: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "co-1" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { useSearchParams: actual.useSearchParams, Link: actual.Link };
});

const pulse: IntelligenceReport = {
  id: "r1",
  companyId: "co-1",
  reportDate: "2026-10-13",
  kind: "daily_pulse",
  status: "published",
  headline: "Meta ships its first frontier model",
  sections: {
    quickWin: { title: "Try Cline on one task", action: "Install Cline and run one refactor.", timeNeeded: "20 minutes", outcome: "A first-hand view." },
    skillIdeas: [],
    trends: [
      {
        headline: "Meta releases Muse Wonder",
        whyItMatters: "A fourth serious US API vendor at the top of the board.",
        freshness: "today",
        sourceName: "TechCrunch",
        url: "https://techcrunch.com/2026/10/12/muse-wonder/",
        learnMore: [],
      },
    ],
    tools: [],
    creators: [],
    opportunities: [],
  },
  createdByAgentId: "a1",
  createdByUserId: null,
  publishedAt: "2026-10-13T06:00:00.000Z",
  createdAt: "2026-10-13T06:00:00.000Z",
  updatedAt: "2026-10-13T06:00:00.000Z",
};

let container: HTMLDivElement;
let root: Root;

async function render(path = "/intelligence") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/intelligence" element={<Intelligence />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

const text = () => container.textContent ?? "";

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  settingsMock.getExperimental.mockResolvedValue({ enableIntelligence: true });
  apiMock.reports.mockResolvedValue({ reports: [] });
  apiMock.boards.mockResolvedValue({ boards: [] });
  apiMock.recommendations.mockResolvedValue({ recommendations: [] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("Intelligence page", () => {
  it("renders the day's pulse: headline, quick win and a sourced trend", async () => {
    apiMock.report.mockImplementation(async (_company: string, _date: string, kind: string) => {
      if (kind === "daily_pulse") return pulse;
      throw new ApiError("Not found", 404, null);
    });
    await render();
    await vi.waitFor(() => expect(text()).toContain("Meta ships its first frontier model"));
    expect(text()).toContain("Try Cline on one task");
    expect(text()).toContain("A fourth serious US API vendor");
    const link = container.querySelector('a[href="https://techcrunch.com/2026/10/12/muse-wonder/"]');
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(apiMock.report).toHaveBeenCalledWith("co-1", "latest", "daily_pulse");
  });

  it("shows the empty state when the agent has not written a pulse", async () => {
    apiMock.report.mockRejectedValue(new ApiError("Not found", 404, null));
    await render();
    await vi.waitFor(() => expect(text()).toContain("No Daily Pulse yet"));
  });

  it("explains the page is off while the switch is off", async () => {
    settingsMock.getExperimental.mockResolvedValue({ enableIntelligence: false });
    await render();
    await vi.waitFor(() => expect(text()).toContain("Intelligence is switched off"));
    expect(apiMock.report).not.toHaveBeenCalled();
  });
});
