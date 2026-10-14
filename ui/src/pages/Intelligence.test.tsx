// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntelligenceBoardView, IntelligenceReport } from "@greatstone/shared";
import { ApiError } from "../api/client";
import { Intelligence } from "./Intelligence";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiMock = vi.hoisted(() => ({
  report: vi.fn(),
  reports: vi.fn(),
  boards: vi.fn(),
  boardHistory: vi.fn(),
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
  apiMock.boardHistory.mockResolvedValue({ history: [] });
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
    await render("/intelligence?tab=today");
    await vi.waitFor(() => expect(text()).toContain("Meta ships its first frontier model"));
    expect(text()).toContain("Try Cline on one task");
    expect(text()).toContain("A fourth serious US API vendor");
    const link = container.querySelector('a[href="https://techcrunch.com/2026/10/12/muse-wonder/"]');
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(apiMock.report).toHaveBeenCalledWith("co-1", "latest", "daily_pulse");
  });

  it("shows the empty state when the agent has not written a pulse, saying who fills it and when", async () => {
    apiMock.report.mockRejectedValue(new ApiError("Not found", 404, null));
    await render("/intelligence?tab=today");
    await vi.waitFor(() => expect(text()).toContain("No Daily Pulse yet"));
    expect(text()).toContain("Lodestone, the Intelligence Analyst agent, publishes the Daily Pulse around 07:00 UK time");
  });

  it("explains when the briefing lands on an empty News tab and an empty GSAM ideas tab", async () => {
    apiMock.report.mockRejectedValue(new ApiError("Not found", 404, null));
    await render("/intelligence?tab=news");
    await vi.waitFor(() => expect(text()).toContain("No briefing yet"));
    expect(text()).toContain("publishes the AI briefing around 06:00 UK time");
    act(() => root.unmount());
    root = createRoot(container);
    await render("/intelligence?tab=gsam");
    await vi.waitFor(() => expect(text()).toContain("No GSAM feature ideas yet"));
    expect(text()).toContain("around 06:00 UK time");
  });

  it("opens each board with a 2nd, 1st, 3rd podium carrying movement, then the rest as a table", async () => {
    apiMock.report.mockRejectedValue(new ApiError("Not found", 404, null));
    const systems: IntelligenceBoardView = {
      board: "ai_systems",
      snapshotDate: "2026-10-13",
      comparedTo: "2026-10-06",
      entries: [
        { name: "Claude", rank: 1, score: 97.3, maker: "Anthropic", movement: { rankDelta: 1, scoreDelta: 1.3, isNew: false } },
        { name: "Gemini", rank: 2, score: 96.6, maker: "Google", movement: { rankDelta: -1, scoreDelta: -0.4, isNew: false } },
        { name: "Muse Wonder", rank: 3, score: 90, maker: "Meta", movement: { rankDelta: null, scoreDelta: null, isNew: true } },
        { name: "Kimi", rank: 4, score: 72, maker: "Moonshot", movement: { rankDelta: 0, scoreDelta: null, isNew: false } },
      ],
    };
    apiMock.boards.mockResolvedValue({ boards: [systems] });
    apiMock.boardHistory.mockResolvedValue({
      history: [
        {
          board: "ai_systems",
          points: [
            { snapshotDate: "2026-10-06", scores: { claude: 96, gemini: 97, kimi: 70 } },
            { snapshotDate: "2026-10-13", scores: { claude: 97.3, gemini: 96.6, kimi: 72, "muse wonder": 90 } },
          ],
        },
      ],
    });
    await render("/intelligence?tab=boards");
    await vi.waitFor(() => expect(container.querySelector('ol[aria-label="AI Systems top three"]')).not.toBeNull());
    const podium = container.querySelector('ol[aria-label$="top three"]')!;
    const steps = [...podium.querySelectorAll("li")];
    expect(steps.map((step) => step.getAttribute("data-place"))).toEqual(["2", "1", "3"]);
    expect(steps.map((step) => step.textContent)).toEqual([
      expect.stringContaining("Gemini"),
      expect.stringContaining("Claude"),
      expect.stringContaining("Muse Wonder"),
    ]);
    expect(steps[1]!.textContent).toContain("Anthropic");
    expect(steps[1]!.querySelector('[aria-label="Up 1 place"]')).not.toBeNull();
    expect(steps[1]!.textContent).toContain("+1.3");
    expect(steps[0]!.querySelector('[aria-label="Down 1 place"]')).not.toBeNull();
    expect(steps[0]!.textContent).toContain("-0.4");
    expect(steps[2]!.textContent).toContain("New");
    expect(steps[1]!.querySelector('svg[aria-label^="Score history: 96 to 97.3"]')).not.toBeNull();

    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("Kimi");
    expect(rows[0]!.querySelector('[aria-label="No change"]')).not.toBeNull();
  });

  it("leads the overview with the lead story's image, logos everywhere, and never loads a remote host", async () => {
    const briefing: IntelligenceReport = {
      ...pulse,
      id: "r2",
      kind: "ai_briefing",
      headline: null,
      sections: {
        news: [
          {
            headline: "Second story",
            tag: "Agents",
            date: "2026-10-12",
            sourceName: "The Verge",
            url: "https://www.theverge.com/x",
            verdict: "A verdict.",
            points: ["One point."],
            action: "Read it.",
            lead: false,
            rumoured: false,
          },
          {
            headline: "Meta releases Muse Wonder",
            tag: "Models",
            date: "2026-10-12",
            sourceName: "TechCrunch",
            url: "https://techcrunch.com/muse",
            imageUrl: "https://cdn.example.com/muse.png",
            verdict: "Meta is near the leaders.",
            points: ["Scores 52."],
            action: "Run it on 20 client tasks.",
            lead: true,
            rumoured: false,
          },
        ],
        radar: { emerging: [], movers: [], watchlist: [] },
      },
    } as IntelligenceReport;
    apiMock.report.mockImplementation(async (_company: string, _date: string, kind: string) => {
      if (kind === "ai_briefing") return briefing;
      throw new ApiError("Not found", 404, null);
    });
    apiMock.boards.mockResolvedValue({
      boards: [
        {
          board: "tools_agents",
          snapshotDate: "2026-10-13",
          comparedTo: null,
          entries: [
            { name: "Cursor", rank: 1, score: 91, maker: "Anysphere", domain: "cursor.com", movement: { rankDelta: null, scoreDelta: null, isNew: false } },
            { name: "Cline", rank: 2, score: 88, movement: { rankDelta: null, scoreDelta: null, isNew: false } },
          ],
        },
      ],
    });
    await render("/intelligence");
    await vi.waitFor(() => expect(text()).toContain("Meta releases Muse Wonder"));
    const hero = container.querySelector("article")!;
    expect(hero.textContent).toContain("Do this: Run it on 20 client tasks.");
    expect(hero.querySelector("time")?.getAttribute("dateTime")).toBe("2026-10-12");
    expect(hero.querySelector("img")?.getAttribute("src")).toContain(encodeURIComponent("https://cdn.example.com/muse.png"));
    expect(container.querySelector('[aria-label="Trending now"]')?.textContent).toContain("Second story");
    const strip = container.querySelector('ol[aria-label="Top tools and agents"]')!;
    expect(strip.querySelector('[data-logo="cursor.com"]')).not.toBeNull();
    expect(strip.querySelector('[data-monogram="CL"]')).not.toBeNull();
    const sources = [...container.querySelectorAll("img")].map((img) => img.getAttribute("src") ?? "");
    expect(sources.length).toBeGreaterThan(3);
    expect(sources.every((src) => src.startsWith("/api/companies/co-1/intelligence/"))).toBe(true);
  });

  it("explains the page is off while the switch is off", async () => {
    settingsMock.getExperimental.mockResolvedValue({ enableIntelligence: false });
    await render();
    await vi.waitFor(() => expect(text()).toContain("Intelligence is switched off"));
    expect(apiMock.report).not.toHaveBeenCalled();
  });
});
