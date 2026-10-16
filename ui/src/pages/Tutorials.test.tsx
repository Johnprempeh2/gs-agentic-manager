// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureTour } from "@/components/FeatureTour";
import { CORE_TOURS, PIPELINE_BOARD_TOUR } from "@/lib/feature-tours";
import { tourSeenKey } from "@/hooks/useTourSeen";
import { GLOSSARY } from "@/lib/glossary";
import { Tutorials } from "./Tutorials";

const flags = vi.hoisted(() => ({
  enablePipelines: true,
  enableStrategyBoard: false,
  enableWebsiteView: true,
  enableApps: false,
}));
const server = vi.hoisted(() => ({
  rows: [] as Array<{ tourKey: string; tourVersion: number; seenAt: string }>,
  resets: 0,
}));
const data = vi.hoisted(() => ({
  pipelines: [] as Array<{ id: string; key: string; archivedAt: string | null }>,
}));

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
vi.mock("@/api/issues", () => ({ issuesApi: { list: async () => [{ id: "i1", identifier: "GRE-7" }] } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: async () => [] } }));
vi.mock("@/api/tools", () => ({ toolsApi: { listConnections: async () => ({ connections: [] }) } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: null }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: () => {} }) }));

let root: Root | undefined;
let container: HTMLDivElement;
let pathname = "";

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
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
});

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

function LocationProbe() {
  pathname = useLocation().pathname;
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
  it("lists every tour whose feature is on, with a description and whether it has been seen", async () => {
    await render();
    const ids = [...document.querySelectorAll("[data-testid^='tutorial-']")].map((el) => el.getAttribute("data-testid"));
    // Board and Share with agents are hidden: their switches are off.
    expect(ids).toEqual([
      ...CORE_TOURS.map((tour) => `tutorial-${tour.id}`),
      "tutorial-pipelines-list",
      "tutorial-pipeline-board",
      "tutorial-client-case",
      "tutorial-website",
    ]);
    expect(row("pipelines-list")!.textContent).toContain("Seen");
    expect(row("pipeline-board")!.textContent).toContain("Not seen yet");
    expect(row("website")!.textContent).toContain("Visitors and Google Search");
  });

  it("keeps the everyday pages when no feature is switched on, and drops the Features group", async () => {
    flags.enablePipelines = false;
    flags.enableWebsiteView = false;
    await render();
    expect(row("dashboard")).not.toBeNull();
    expect(row("website")).toBeNull();
    expect(document.querySelector('section[aria-label="Features"]')).toBeNull();
    expect(document.querySelector('section[aria-label="Everyday pages"]')).not.toBeNull();
    flags.enableWebsiteView = true;
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
});
