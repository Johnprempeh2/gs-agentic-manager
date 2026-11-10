// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureTour } from "@/components/FeatureTour";
import { ALL_TOURS, PIPELINE_BOARD_TOUR } from "@/lib/feature-tours";
import { tourSeenKey } from "@/hooks/useTourSeen";
import { GLOSSARY } from "@/lib/glossary";
import { AREAS, Tutorials } from "./Tutorials";

const flags = vi.hoisted(() => ({
  enablePipelines: true,
  enableStrategyBoard: false,
  enableWebsiteView: true,
  enableApps: false,
  enableStatusCards: false,
  enableCases: false,
  enableDeepDive: false,
}));
const server = vi.hoisted(() => ({
  rows: [] as Array<{ tourKey: string; tourVersion: number; seenAt: string }>,
  resets: 0,
}));
const data = vi.hoisted(() => ({
  pipelines: [] as Array<{ id: string; key: string; archivedAt: string | null }>,
  pages: [] as Array<{ id: string; slug: string; status: string; archivedAt: string | null }>,
  shop: false,
}));
const access = vi.hoisted(() => ({ canRelease: false }));

vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: async () => ({ ...flags }) } }));
vi.mock("@/api/auth", () => ({ authApi: { getSession: async () => ({ user: { id: "ama" } }) } }));
vi.mock("@/api/tourDismissals", () => ({
  tourDismissalsApi: {
    list: async () => server.rows.map((row) => ({ ...row })),
    markSeen: async () => {},
    reset: async () => { server.resets += 1; server.rows = []; },
  },
}));
vi.mock("@/api/pipelines", () => ({
  pipelinesApi: {
    list: async () => data.pipelines,
    listCases: async () => [],
  },
}));
vi.mock("@/api/website", () => ({
  websiteModuleApi: { sites: async () => [{ id: "site-1" }], pages: async () => data.pages },
}));
vi.mock("@/hooks/useReleases", () => ({ useCanRelease: () => ({ canRelease: access.canRelease, isLoading: false }) }));
vi.mock("@/hooks/useCommerceSite", () => ({ useCommerceSite: () => ({ commerce: data.shop ? {} : null, isLoading: false }) }));
vi.mock("@/api/issues", () => ({ issuesApi: { list: async () => [{ id: "i1", identifier: "GRE-7" }] } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: async () => [] } }));
vi.mock("@/api/tools", () => ({ toolsApi: { listConnections: async () => ({ connections: [] }) } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: null }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: () => {} }) }));

let root: Root | undefined;
let container: HTMLDivElement;
let pathname = "";
let search = "";

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  flags.enablePipelines = true;
  server.rows = [{ tourKey: "pipelines-list", tourVersion: 1, seenAt: "2026-10-01T00:00:00.000Z" }];
  server.resets = 0;
  data.pipelines = [
    { id: "old", key: "sales", archivedAt: "2026-01-01" },
    { id: "pipe-1", key: "sales", archivedAt: null },
  ];
  data.pages = [
    { id: "p-home", slug: "/", status: "built", archivedAt: null },
    { id: "p-plan", slug: "/pricing", status: "planned", archivedAt: null },
    { id: "p-gone", slug: "/old", status: "built", archivedAt: "2026-01-01" },
    { id: "p-about", slug: "/about", status: "built", archivedAt: null },
  ];
  data.shop = false;
  access.canRelease = false;
  Object.assign(flags, { enableStatusCards: false, enableCases: false, enableDeepDive: false });
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
});

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

function LocationProbe() {
  ({ pathname, search } = useLocation());
  return null;
}

async function render() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/tutorials"]}>
        <LocationProbe />
        <Routes>
          <Route path="/tutorials" element={<Tutorials />} />
          <Route path="/pipelines/:pipelineId" element={(
            <>
              <div data-tour="board-columns">columns</div>
              <FeatureTour tour={PIPELINE_BOARD_TOUR} />
            </>
          )} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  ));
  for (let i = 0; i < 4; i += 1) await flush();
}

const row = (id: string) => document.querySelector<HTMLElement>(`[data-testid="tutorial-${id}"]`);
const startButton = (id: string) => row(id)!.querySelector("button")!;
const button = (text: string) =>
  [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === text) as HTMLButtonElement | undefined;

describe("Tutorials", () => {
  it("lists every tour whose feature is on by area, with a description and whether it has been seen", async () => {
    await render();
    const byArea = [...document.querySelectorAll("section[aria-label]")]
      .filter((section) => section.querySelector("[data-testid^='tutorial-']"))
      .map((section) => [
        section.getAttribute("aria-label"),
        [...section.querySelectorAll("[data-testid^='tutorial-']")].map((el) => el.getAttribute("data-testid")!.replace("tutorial-", "")),
      ]);
    // Board, Share with agents and chats are hidden: their switches are off. No shop, so no catalogue.
    expect(byArea).toEqual([
      ["Getting started", ["welcome", "search-ask", "search", "since-last-visit"]],
      ["Today", ["decisions", "my-tasks", "inbox", "calendar", "blocked", "approvals", "morning"]],
      ["Work", ["dashboard", "tasks", "task-detail", "projects", "goals", "memory", "workflows", "artifacts", "links"]],
      ["Team", ["agents", "agent-detail", "scorecard", "weekly-report", "conference-room"]],
      ["Clients", ["organisations", "pipelines-list", "pipeline-board", "client-case", "deliverables", "images"]],
      ["Website and Commerce", ["website-home", "website-preview", "website-sitemap", "website-pages", "website-editor", "website-progress", "website-collections", "website-style", "website-documents", "website-people", "website-releases", "website"]],
      ["Set-up", ["routines", "integrations", "connectors", "skills", "settings"]],
    ]);
    expect(row("pipelines-list")!.textContent).toContain("Seen");
    expect(row("pipeline-board")!.textContent).toContain("Not seen yet");
    expect(row("website")!.textContent).toContain("Visitors and Google Search");
  });

  it("gives every tour an area, so nothing lands in More", () => {
    const named = AREAS.flatMap((area) => area.ids);
    expect(new Set(named).size).toBe(named.length);
    expect([...named].sort()).toEqual(ALL_TOURS.map((tour) => tour.id).sort());
  });

  it("says Replay on a tour that was seen and Start on one that was not", async () => {
    await render();
    expect(startButton("pipelines-list").textContent).toBe("Replay");
    expect(startButton("pipelines-list").getAttribute("aria-label")).toBe("Replay the Pipelines tutorial");
    expect(startButton("pipeline-board").textContent).toBe("Start");
  });

  it("drops an area when none of its features is switched on", async () => {
    flags.enablePipelines = false;
    flags.enableWebsiteView = false;
    await render();
    expect(row("dashboard")).not.toBeNull();
    expect(row("website")).toBeNull();
    expect(document.querySelector('section[aria-label="Website and Commerce"]')).toBeNull();
    expect(document.querySelector('section[aria-label="Work"]')).not.toBeNull();
    flags.enableWebsiteView = true;
  });

  it("opens the sitemap tab with its tour, keeping the tab in the address", async () => {
    await render();
    await act(async () => startButton("website-sitemap").click());
    await flush();
    expect(pathname + search).toBe("/website?tab=sitemap&tour=website-sitemap");
  });

  it("opens each Website tab tour on its own tab", async () => {
    for (const [id, tab] of [
      ["website-pages", "editor"], ["website-progress", "progress"], ["website-collections", "collections"], ["website-releases", "releases"],
      ["website-preview", "preview"], ["website-style", "style"], ["website-documents", "documents"], ["website-people", "people"],
    ]) {
      await render();
      await act(async () => startButton(id).click());
      await flush();
      expect(pathname + search).toBe(`/website?tab=${tab}&tour=${id}`);
    }
  });

  it("opens the page editor on the first built page that is not the home page", async () => {
    await render();
    await act(async () => startButton("website-editor").click());
    await flush();
    expect(pathname + search).toBe("/website/sites/site-1/pages/p-about/design?tour=website-editor");
  });

  it("says so when there is no built page to open the editor on", async () => {
    data.pages = data.pages.filter((page) => page.status === "planned");
    await render();
    await act(async () => startButton("website-editor").click());
    await flush();
    expect(pathname).toBe("/tutorials");
    expect(row("website-editor")!.textContent).toContain("There are no built pages yet");
  });

  it("lists the catalogue tour where there is a shop", async () => {
    data.shop = true;
    await render();
    expect(row("commerce-catalogue")!.textContent).toContain("Commerce catalogue");
    expect(row("commerce-sales")!.textContent).toContain("Commerce sales");
    await act(async () => startButton("commerce-catalogue").click());
    await flush();
    expect(pathname).toBe("/commerce/offerings");
    await render();
    await act(async () => startButton("commerce-sales").click());
    await flush();
    expect(pathname).toBe("/commerce/quotes");
    for (const [id, path] of [["commerce-catalogue-setup", "/commerce/vendors"], ["commerce-clients", "/commerce/customers"]]) {
      await render();
      await act(async () => startButton(id).click());
      await flush();
      expect(pathname).toBe(path);
    }
  });

  it("Start on the task tour opens the newest task, and says so when there are no agents", async () => {
    await render();
    await act(async () => startButton("agent-detail").click());
    await flush();
    expect(row("agent-detail")!.textContent).toContain("There are no agents yet");
    await act(async () => startButton("task-detail").click());
    await flush();
    expect(pathname).toBe("/issues/GRE-7");
  });

  it("Start on an everyday page opens that page with its tour", async () => {
    await render();
    await act(async () => startButton("decisions").click());
    await flush();
    expect(pathname).toBe("/decisions");
  });

  it("puts the welcome tour first under Start here and replays it on Home", async () => {
    await render();
    expect(document.querySelector("[data-testid^='tutorial-']")).toBe(row("welcome"));
    expect(row("welcome")!.textContent).toContain("Welcome to GSAM");
    await act(async () => startButton("welcome").click());
    await flush();
    expect(pathname).toBe("/dashboard");
  });

  it("Start opens the first live pipeline's board and starts its tour there", async () => {
    await render();
    await act(async () => startButton("pipeline-board").click());
    for (let i = 0; i < 4; i += 1) await flush();
    expect(pathname).toBe("/pipelines/pipe-1");
    expect(document.querySelector('[data-testid="feature-tour"]')?.textContent).toContain("Stages as columns");
  });

  it("says plainly when there is nothing to open yet", async () => {
    data.pipelines = [];
    await render();
    await act(async () => startButton("client-case").click());
    await flush();
    expect(pathname).toBe("/tutorials");
    expect(row("client-case")!.textContent).toContain("There are no clients yet");
  });

  it("Show all tutorials again clears seen on the server and in this browser", async () => {
    localStorage.setItem(tourSeenKey({ id: "website", version: 1 }, "ama"), "1");
    await render();
    await act(async () => button("Show all tutorials again")!.click());
    await flush();
    expect(server.resets).toBe(1);
    expect(localStorage.getItem(tourSeenKey({ id: "website", version: 1 }, "ama"))).toBeNull();
    expect(row("pipelines-list")!.textContent).toContain("Not seen yet");
    expect(container.textContent).toContain("Every tutorial will open again");
  });
  it("lists the words we use in plain words", async () => {
    await render();
    const words = document.getElementById("words")!;
    const terms = [...words.querySelectorAll("dt")].map((el) => el.textContent);
    expect(terms).toEqual(GLOSSARY.map((entry) => entry.term));
    expect(words.querySelector("#word-routine")?.textContent).toContain("Work that repeats on a schedule");
  });

  it("leads a new person through the first tours in order, the welcome first", async () => {
    server.rows = ["welcome", "decisions"].map((tourKey) => ({ tourKey, tourVersion: 1, seenAt: "2026-10-01T00:00:00.000Z" }));
    await render();
    const card = document.querySelector<HTMLElement>('[data-testid="tutorials-start-here"]')!;
    expect(card.textContent).toContain("2 of 4 done");
    expect([...card.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "1. Welcome to GSAM(done)",
      "2. Decisions(done)",
      "3. Tasks(not done yet)",
      "4. Agents(not done yet)",
    ]);
    const next = [...card.querySelectorAll("button")].find((el) => el.textContent === "Next: Tasks")!;
    await act(async () => next.click());
    await flush();
    expect(pathname).toBe("/issues");
  });

  it("lists GSAM releases only for owners and admins, and the Deep Dive only with Cases on", async () => {
    Object.assign(flags, { enableStatusCards: true, enableDeepDive: true });
    await render();
    expect(row("status")).not.toBeNull();
    expect(row("gsam-releases")).toBeNull();
    expect(row("deep-dive")).toBeNull();
    expect(row("cases")).toBeNull();
    access.canRelease = true;
    flags.enableCases = true;
    await render();
    expect(row("gsam-releases")).not.toBeNull();
    expect(row("deep-dive")).not.toBeNull();
    expect(row("cases")).not.toBeNull();
    await act(async () => startButton("gsam-releases").click());
    await flush();
    expect(pathname + search).toBe("/releases?tour=gsam-releases");
  });
});
