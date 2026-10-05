// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MEMORY_ACTIVITY_NOTE,
  type MemoryActivityCounts,
  type MemoryActivityFeed,
  type MemoryActivityItem,
  type MemoryRecord,
} from "@greatstone/shared";
import { ApiError } from "../api/client";
import { kestrelAgents, kestrelGraph, kestrelNodes } from "../fixtures/memoryKestrel";
import { APPROVED_MEANING } from "../components/memory/memoryLabels";
import { MemoryActivity, groupActivity, toActivityQuery } from "./MemoryActivity";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const memoryApiMock = vi.hoisted(() => ({
  graph: vi.fn(),
  node: vi.fn(),
  edge: vi.fn(),
  activity: vi.fn(),
  activityCounts: vi.fn(),
}));

vi.mock("../api/memoryGraph", () => ({ memoryGraphApi: memoryApiMock }));
vi.mock("../api/agents", () => ({ agentsApi: { list: vi.fn(async () => []) } }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "co-kestrel" }) }));
vi.mock("../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    useSearchParams: actual.useSearchParams,
    useNavigate: actual.useNavigate,
    Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  };
});

function item(index: number, createdAt: string, contributor = kestrelAgents.mason): MemoryActivityItem {
  const node = kestrelNodes[index];
  return {
    record: {
      id: node.id,
      title: node.title,
      content: node.excerpt,
      status: node.status,
      createdAt,
    } as MemoryRecord,
    scopeName: node.scopeName,
    contributor,
    source: node.source,
    history: [
      {
        id: `ev-${node.id}`,
        recordId: node.id,
        scopeId: node.scopeId,
        action: "approve",
        fromStatus: "unreviewed",
        toStatus: "approved",
        actorType: "user",
        actorId: "hu-john-syn",
        agentId: null,
        userId: "hu-john-syn",
        runId: null,
        reason: null,
        relatedRecordId: null,
        createdAt,
      },
    ],
    extractedFactCount: 2,
  };
}

const feed: MemoryActivityFeed = {
  items: [
    item(0, "2026-10-04T12:00:00.000Z", kestrelAgents.scribe),
    item(2, "2026-10-04T09:00:00.000Z", kestrelAgents.mason),
    item(3, "2026-10-03T09:00:00.000Z", kestrelAgents.everest),
  ],
  nextCursor: null,
};

const zero = { unreviewed: 0, approved: 0, disputed: 0, superseded: 0, deleted: 0 };
const counts: MemoryActivityCounts = {
  note: MEMORY_ACTIVITY_NOTE,
  contributors: [
    { contributor: kestrelAgents.everest, contributionCount: 1, contributionCountByStatus: { ...zero, disputed: 1 }, relationshipsStatedCount: 1, reviewActionCount: 0 },
    { contributor: kestrelAgents.mason, contributionCount: 9, contributionCountByStatus: { ...zero, unreviewed: 9 }, relationshipsStatedCount: 0, reviewActionCount: 0 },
    { contributor: kestrelAgents.scribe, contributionCount: 2, contributionCountByStatus: { ...zero, approved: 2 }, relationshipsStatedCount: 1, reviewActionCount: 0 },
  ],
};

let container: HTMLDivElement;
let root: Root;
let currentSearch = "";

function LocationProbe() {
  currentSearch = useLocation().search;
  return null;
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderAt(path: string) {
  act(() => root.unmount());
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/memory/activity" element={<><MemoryActivity /><LocationProbe /></>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}

const text = () => container.textContent ?? "";

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  memoryApiMock.activity.mockResolvedValue(feed);
  memoryApiMock.activityCounts.mockResolvedValue(counts);
  memoryApiMock.graph.mockResolvedValue(kestrelGraph);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("Memory contributions view", () => {
  it("labels counts as activity and lists them in name order whatever the server sends, not a ranking", async () => {
    const boardMember = { actorType: "user" as const, agentId: null, userId: "user-1", name: null };
    memoryApiMock.activityCounts.mockResolvedValue({
      ...counts,
      contributors: [
        counts.contributors[1],
        counts.contributors[2],
        { ...counts.contributors[0], contributor: boardMember },
        counts.contributors[0],
      ],
    });
    await renderAt("/memory/activity");

    expect(text()).toContain("Activity by contributor");
    expect(text()).toContain(MEMORY_ACTIVITY_NOTE);
    expect(text()).toContain(APPROVED_MEANING);
    const names = Array.from(container.querySelectorAll("tbody th")).map((cell) => cell.textContent);
    expect(names).toEqual(["A board member", "Everest (synthetic)", "Mason (synthetic)", "Scribe (synthetic)"]);
    expect(text().replace(MEMORY_ACTIVITY_NOTE, "")).not.toMatch(/\b(rank|score|top contributor|best|leader)/i);
  });

  it("drills down from a count to that contributor's entries", async () => {
    await renderAt("/memory/activity");
    const mason = Array.from(container.querySelectorAll<HTMLButtonElement>("tbody th button")).find((b) => b.textContent === "Mason (synthetic)")!;
    await act(async () => mason.click());
    await flush();

    expect(currentSearch).toContain("agent=ag-mason-syn");
    expect(memoryApiMock.activity).toHaveBeenLastCalledWith("co-kestrel", expect.objectContaining({ agentId: "ag-mason-syn" }));
    expect(mason.getAttribute("aria-pressed")).toBe("true");
  });

  it("shows each entry's contributor, source, status, reviews and extraction, and links to the graph", async () => {
    await renderAt("/memory/activity");

    const first = container.querySelector("li")!;
    expect(first.textContent).toContain("Scribe (synthetic)");
    expect(first.textContent).toContain("Task issue-r");
    expect(first.textContent).toContain("Approved");
    expect(first.textContent).toContain("Approved by A board member");
    expect(first.textContent).toContain("2 facts");
    expect(first.querySelector('a[href="/memory?node=rec-hours"]')?.textContent).toBe("Show in graph");
    expect(first.querySelector('a[href="/issues/issue-rec-hours"]')).not.toBeNull();
  });

  it("groups by date, newest first, or by contributor name", async () => {
    await renderAt("/memory/activity");
    const dateGroups = Array.from(container.querySelectorAll("section[aria-label] h3")).map((h) => h.textContent);
    expect(dateGroups).toHaveLength(2);

    await renderAt("/memory/activity?group=contributor");
    const people = Array.from(container.querySelectorAll("section[aria-label] h3")).map((h) => h.textContent);
    expect(people).toEqual(["Everest (synthetic)", "Mason (synthetic)", "Scribe (synthetic)"]);
  });

  it("shows empty, filtered-empty and restricted states instead of errors", async () => {
    memoryApiMock.activity.mockResolvedValue({ items: [], nextCursor: null });
    memoryApiMock.activityCounts.mockResolvedValue({ note: MEMORY_ACTIVITY_NOTE, contributors: [] });
    await renderAt("/memory/activity");
    expect(text()).toContain("No contributions yet.");

    await renderAt("/memory/activity?status=disputed");
    expect(text()).toContain("No contributions match these filters.");

    memoryApiMock.activity.mockRejectedValue(new ApiError("Forbidden", 403, null));
    await renderAt("/memory/activity");
    expect(text()).toContain("You do not have access to memory in this organization.");
  });
});

describe("toActivityQuery", () => {
  it("sends the day after the chosen end date, because the gateway's `to` is exclusive", () => {
    const query = toActivityQuery(new URLSearchParams("from=2026-10-01&to=2026-10-31&status=approved&agent=a1"));
    expect(query).toMatchObject({ from: "2026-10-01", to: "2026-11-01", status: "approved", agentId: "a1" });
  });

  it("drops an unknown status", () => {
    expect(toActivityQuery(new URLSearchParams("status=best")).status).toBeUndefined();
  });
});

describe("groupActivity", () => {
  it("never orders contributors by how much they added", () => {
    const many = [0, 2, 3, 4].map((i) => item(i, "2026-10-04T09:00:00.000Z", kestrelAgents.mason));
    const groups = groupActivity([item(0, "2026-10-04T09:00:00.000Z", kestrelAgents.scribe), ...many, item(3, "2026-10-04T09:00:00.000Z", kestrelAgents.everest)], "contributor");
    expect(groups.map((group) => group.label)).toEqual(["Everest (synthetic)", "Mason (synthetic)", "Scribe (synthetic)"]);
  });
});
