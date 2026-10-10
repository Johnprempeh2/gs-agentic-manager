// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebsiteOverview, WebsiteProperty, WebsiteReport } from "@greatstone/shared";
import { ApiError } from "../api/client";
import { Website, formatRange } from "./Website";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const websiteApiMock = vi.hoisted(() => ({
  overview: vi.fn(),
  report: vi.fn(),
  connectGoogle: vi.fn(),
}));
const settingsMock = vi.hoisted(() => ({ getExperimental: vi.fn() }));

vi.mock("../api/website", async () => {
  const actual = await vi.importActual<typeof import("../api/website")>("../api/website");
  return { ...actual, websiteApi: websiteApiMock };
});
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: settingsMock }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "co-1" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { useSearchParams: actual.useSearchParams };
});

function property(overrides: Partial<WebsiteProperty> = {}): WebsiteProperty {
  return {
    id: "prop-1",
    companyId: "co-1",
    name: "Greatstone",
    siteUrl: "https://greatstone.example/",
    ga4PropertyId: "123456789",
    connectionStatus: "connected",
    connectedAt: "2026-10-08T09:00:00.000Z",
    lastPullAt: "2026-10-09T06:00:00.000Z",
    lastPullStatus: "succeeded",
    lastPullErrors: [],
    nextPullDueAt: "2026-10-10T06:00:00.000Z",
    createdAt: "2026-10-08T09:00:00.000Z",
    updatedAt: "2026-10-09T06:00:00.000Z",
    ...overrides,
  };
}

const range = { startDate: "2026-09-11", endDate: "2026-10-08" };

function report(overrides: Partial<WebsiteReport> = {}): WebsiteReport {
  return {
    property: property(),
    lastPull: {
      id: "pull-1",
      propertyId: "prop-1",
      trigger: "schedule",
      status: "succeeded",
      startedAt: "2026-10-09T06:00:00.000Z",
      finishedAt: "2026-10-09T06:00:05.000Z",
      range,
      errors: [],
    },
    ga4: {
      range,
      totals: { visitors: 1234, sessions: 1500, pageViews: 4200, conversions: 37 },
      sources: [{ source: "google", medium: "organic", sessions: 800, visitors: 700 }],
      topPages: [{ path: "/pricing", title: "Pricing", views: 900, visitors: 600 }],
      conversions: [{ eventName: "contact_form_submit", count: 37 }],
      dailyTrend: [
        { date: "2026-10-07", visitors: 40, sessions: 50, conversions: 1 },
        { date: "2026-10-08", visitors: 55, sessions: 60, conversions: 2 },
      ],
    },
    ga4PulledAt: "2026-10-09T06:00:05.000Z",
    searchConsole: {
      range,
      totals: { clicks: 321, impressions: 9876, ctr: 0.0325, averagePosition: 12.345 },
      queries: [{ query: "greatstone consulting", clicks: 120, impressions: 800, ctr: 0.15, position: 2.1 }],
      dailyTrend: [],
      pagesInspected: 10,
      pagesNotIndexed: [
        { url: "https://greatstone.example/old", verdict: "NEUTRAL", coverageState: "Crawled - currently not indexed", lastCrawlTime: null },
      ],
    },
    searchConsolePulledAt: "2026-10-09T06:00:05.000Z",
    ...overrides,
  };
}

function overview(overrides: Partial<WebsiteOverview> = {}): WebsiteOverview {
  return { googleSignInAvailable: true, properties: [property()], ...overrides };
}

let container: HTMLDivElement;
let root: Root;
let location = "";

function LocationProbe() {
  const current = useLocation();
  location = `${current.pathname}${current.search}`;
  return null;
}

async function render(path = "/website") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/website" element={<><Website /><LocationProbe /></>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

const text = () => container.textContent ?? "";

async function waitForText(expected: string) {
  await vi.waitFor(() => expect(text()).toContain(expected));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  settingsMock.getExperimental.mockResolvedValue({ enableWebsiteView: true });
  websiteApiMock.overview.mockResolvedValue(overview());
  websiteApiMock.report.mockResolvedValue(report());
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("Website page", () => {
  it("shows the switched-off state without calling the Website API when the switch is off", async () => {
    settingsMock.getExperimental.mockResolvedValue({ enableWebsiteView: false });
    await render();
    await waitForText("The Website view is switched off");
    expect(websiteApiMock.overview).not.toHaveBeenCalled();
  });

  it("shows the switched-off state when the server answers 403 not_entitled", async () => {
    websiteApiMock.overview.mockRejectedValue(
      new ApiError("The Website view is not part of this plan", 403, { code: "not_entitled" }),
    );
    await render();
    await waitForText("The Website view is switched off");
  });

  it("shows a load error with a retry for other failures", async () => {
    websiteApiMock.overview.mockRejectedValue(new ApiError("Server down", 500, null));
    await render();
    await waitForText("Could not load this page");
    expect(text()).toContain("Server down");
  });

  it("shows the empty state when no website is set up", async () => {
    websiteApiMock.overview.mockResolvedValue(overview({ properties: [] }));
    await render();
    await waitForText("No website is set up yet");
  });

  it("shows every GA4 and Search Console section from the stored pull", async () => {
    await render();
    await waitForText("1,234");
    const page = text();
    expect(page).toContain("Visitors per day");
    expect(page).toContain("google");
    expect(page).toContain("Pricing");
    expect(page).toContain("contact_form_submit");
    expect(page).toContain("321");
    expect(page).toContain("9,876");
    expect(page).toContain("12.3");
    expect(page).toContain("greatstone consulting");
    expect(page).toContain("1 of 10 checked pages");
    expect(page).toContain("Crawled - currently not indexed");
    expect(container.querySelector('[data-testid="website-pull-status"]')?.textContent).toContain("Last pull:");
    // Read-only: a connected property offers no Connect button.
    expect(page).not.toContain("Connect Google");
  });

  it("lists pull errors by source", async () => {
    websiteApiMock.report.mockResolvedValue(
      report({
        lastPull: {
          ...report().lastPull!,
          status: "partial",
          errors: [{ source: "search_console", message: "User does not have sufficient permission" }],
        },
      }),
    );
    await render();
    await waitForText("The last pull had a problem");
    expect(text()).toContain("Search Console: User does not have sufficient permission");
    expect(text()).toContain("Partly pulled");
  });

  it("offers Connect Google before the first pull and opens the authorization URL", async () => {
    const notConnected = property({ connectionStatus: "not_connected", lastPullAt: null, lastPullStatus: null, nextPullDueAt: null });
    websiteApiMock.overview.mockResolvedValue(overview({ properties: [notConnected] }));
    websiteApiMock.report.mockResolvedValue(
      report({ property: notConnected, lastPull: null, ga4: null, ga4PulledAt: null, searchConsole: null, searchConsolePulledAt: null }),
    );
    websiteApiMock.connectGoogle.mockResolvedValue({ authorizationUrl: "https://accounts.google.example/o/oauth2" });
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, assign });

    await render();
    await waitForText("Connect Google to see your website data");
    expect(text()).toContain("never");
    const button = Array.from(container.querySelectorAll("button")).find((el) => el.textContent === "Connect Google")!;
    await act(async () => { button.click(); });
    for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
    expect(websiteApiMock.connectGoogle).toHaveBeenCalledWith("co-1", "prop-1");
    expect(assign).toHaveBeenCalledWith("https://accounts.google.example/o/oauth2");
  });

  it("says Google sign-in is not set up instead of showing the button", async () => {
    const notConnected = property({ connectionStatus: "not_connected" });
    websiteApiMock.overview.mockResolvedValue(overview({ googleSignInAvailable: false, properties: [notConnected] }));
    websiteApiMock.report.mockResolvedValue(report({ property: notConnected, lastPull: null, ga4: null, searchConsole: null }));
    await render();
    await waitForText("Google sign-in is not set up on this instance.");
    expect(text()).not.toMatch(/Connect Google$/m);
  });

  it("shows the Google return notice once and clears it from the URL", async () => {
    await render("/website?websiteGoogle=connected");
    await waitForText("Google is connected.");
    expect(location).toBe("/website");
  });
});

describe("formatRange", () => {
  it("reads the dates as calendar days", () => {
    expect(formatRange(range)).toBe("11 Sept – 8 Oct 2026");
  });
});
