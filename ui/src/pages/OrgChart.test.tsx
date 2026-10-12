// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { OrgChart } from "./OrgChart";

const navigateMock = vi.fn();
const orgMock = vi.fn();
const listMock = vi.fn();
const issuesMock = vi.fn();
const liveRunsMock = vi.fn();
const teamsMock = vi.fn();

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => navigateMock,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    org: () => orgMock(),
    list: () => listMock(),
  },
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    listCompact: () => issuesMock(),
  },
}));

vi.mock("../api/agentTeams", () => ({
  agentTeamsApi: {
    list: () => teamsMock(),
  },
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: {
    liveRunsForCompany: () => liveRunsMock(),
  },
}));

vi.mock("../components/AgentIconPicker", () => ({
  AgentIcon: () => <span data-testid="agent-icon" />,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const orgTree = [
  {
    id: "agent-1",
    name: "CEO",
    role: "ceo",
    status: "active",
    reports: [
      {
        id: "agent-2",
        name: "Engineer",
        role: "engineer",
        status: "active",
        reports: [],
      },
    ],
  },
];

const agents = [
  {
    id: "agent-1",
    companyId: "company-1",
    name: "CEO",
    role: "ceo",
    title: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    contextMode: "thin",
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    lastHeartbeatAt: null,
    icon: "briefcase",
    metadata: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    urlKey: "ceo",
    pauseReason: null,
    pausedAt: null,
    permissions: null,
  },
  {
    id: "agent-2",
    companyId: "company-1",
    name: "Engineer",
    role: "engineer",
    title: null,
    status: "active",
    reportsTo: "agent-1",
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    contextMode: "thin",
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    lastHeartbeatAt: null,
    icon: "code",
    metadata: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    urlKey: "engineer",
    pauseReason: null,
    pausedAt: null,
    permissions: null,
  },
];

function createTouchEvent(type: string, touches: Array<{ clientX: number; clientY: number }>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", {
    value: touches,
  });
  Object.defineProperty(event, "changedTouches", {
    value: touches,
  });
  return event;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function parseTransform(layer: HTMLDivElement) {
  const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(layer.style.transform);
  if (!match) throw new Error(`unexpected transform ${layer.style.transform}`);
  return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) };
}

function wheel(target: Element, init: WheelEventInit) {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function card(container: HTMLElement, agentId: string) {
  return container.querySelector(`[data-agent-id="${agentId}"]`) as HTMLDivElement | null;
}

describe("OrgChart", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;
  let viewportWidth: number;
  let viewportHeight: number;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // Wide enough that the two-card test chart fits at zoom 1:
    // bounds 368 x 456, so the fitted pan is (26, 82).
    viewportWidth = 420;
    viewportHeight = 620;
    orgMock.mockResolvedValue(orgTree);
    listMock.mockResolvedValue(agents);
    issuesMock.mockResolvedValue([]);
    liveRunsMock.mockResolvedValue([]);
    teamsMock.mockResolvedValue([]);

    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return this.getAttribute("data-testid") === "org-chart-viewport" ? viewportWidth : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.getAttribute("data-testid") === "org-chart-viewport" ? viewportHeight : 0;
      },
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function getRect(this: HTMLElement) {
      const isViewport = this.getAttribute("data-testid") === "org-chart-viewport";
      const width = isViewport ? viewportWidth : 0;
      const height = isViewport ? viewportHeight : 0;
      return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) };
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    container.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  async function renderOrgChart() {
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <OrgChart />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return {
      viewport: container.querySelector('[data-testid="org-chart-viewport"]') as HTMLDivElement,
      layer: container.querySelector('[data-testid="org-chart-card-layer"]') as HTMLDivElement,
    };
  }

  async function typeSearch(value: string) {
    const input = container.querySelector('input[aria-label="Find an agent"]') as HTMLInputElement;
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      nativeSetter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return input;
  }

  describe("wheel and trackpad", () => {
    it("pans the chart on plain scroll and stops the page scrolling", async () => {
      const { viewport, layer } = await renderOrgChart();
      const before = parseTransform(layer);

      let event!: WheelEvent;
      await act(async () => {
        event = wheel(viewport, { deltaX: 30, deltaY: 50 });
      });

      expect(event.defaultPrevented).toBe(true);
      expect(parseTransform(layer)).toEqual({ x: before.x - 30, y: before.y - 50, zoom: before.zoom });
    });

    it("pans sideways on shift + mouse wheel", async () => {
      const { viewport, layer } = await renderOrgChart();
      const before = parseTransform(layer);

      await act(async () => {
        wheel(viewport, { deltaY: 40, shiftKey: true });
      });

      expect(parseTransform(layer)).toEqual({ x: before.x - 40, y: before.y, zoom: before.zoom });
    });

    it("zooms toward the pointer on ctrl + scroll", async () => {
      const { viewport, layer } = await renderOrgChart();
      const before = parseTransform(layer);

      let event!: WheelEvent;
      await act(async () => {
        event = wheel(viewport, { deltaY: -40, ctrlKey: true, clientX: 200, clientY: 300 });
      });

      const after = parseTransform(layer);
      expect(event.defaultPrevented).toBe(true);
      expect(after.zoom).toBeCloseTo(before.zoom * Math.exp(0.1), 5);
      // The chart point under the pointer stays under the pointer.
      expect((200 - after.x) / after.zoom).toBeCloseTo((200 - before.x) / before.zoom, 5);
      expect((300 - after.y) / after.zoom).toBeCloseTo((300 - before.y) / before.zoom, 5);
    });

    it("zooms on ⌘ + scroll too", async () => {
      const { viewport, layer } = await renderOrgChart();

      await act(async () => {
        wheel(viewport, { deltaY: 40, metaKey: true });
      });

      expect(parseTransform(layer).zoom).toBeLessThan(1);
    });

    it("zooms at a smooth rate: small trackpad steps barely move, a wheel notch is capped", async () => {
      const { viewport, layer } = await renderOrgChart();

      await act(async () => {
        wheel(viewport, { deltaY: -4, ctrlKey: true });
      });
      expect(parseTransform(layer).zoom).toBeCloseTo(Math.exp(0.01), 5);

      await act(async () => {
        wheel(viewport, { deltaY: -500, ctrlKey: true });
      });
      expect(parseTransform(layer).zoom).toBeCloseTo(Math.exp(0.01) * Math.exp(0.125), 5);
    });
  });

  describe("touch", () => {
    it("pans the chart with one-finger touch drag", async () => {
      const { viewport, layer } = await renderOrgChart();

      await act(async () => {
        viewport.dispatchEvent(createTouchEvent("touchstart", [{ clientX: 100, clientY: 100 }]));
        viewport.dispatchEvent(createTouchEvent("touchmove", [{ clientX: 130, clientY: 145 }]));
        viewport.dispatchEvent(createTouchEvent("touchend", []));
      });

      expect(layer.style.transform).toBe("translate(56px, 127px) scale(1)");
    });

    it("pinch-zooms toward the touch center", async () => {
      const { viewport, layer } = await renderOrgChart();

      await act(async () => {
        viewport.dispatchEvent(createTouchEvent("touchstart", [
          { clientX: 100, clientY: 100 },
          { clientX: 200, clientY: 100 },
        ]));
        viewport.dispatchEvent(createTouchEvent("touchmove", [
          { clientX: 75, clientY: 100 },
          { clientX: 225, clientY: 100 },
        ]));
        viewport.dispatchEvent(createTouchEvent("touchend", []));
      });

      expect(layer.style.transform).toBe("translate(-36px, 73px) scale(1.5)");
    });

    it("does not open the side panel after a touch pan", async () => {
      const { viewport } = await renderOrgChart();

      await act(async () => {
        viewport.dispatchEvent(createTouchEvent("touchstart", [{ clientX: 100, clientY: 100 }]));
        viewport.dispatchEvent(createTouchEvent("touchmove", [{ clientX: 130, clientY: 145 }]));
        viewport.dispatchEvent(createTouchEvent("touchend", []));
        card(container, "agent-1")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });

      expect(document.querySelector('[role="dialog"]')).toBeNull();
    });

    it("does not produce a negative zoom while the viewport has no usable height", async () => {
      viewportHeight = 2;
      const { layer } = await renderOrgChart();

      expect(layer.style.transform).toBe("translate(0px, 0px) scale(1)");

      await act(async () => {
        (container.querySelector('[aria-label="Fit chart to screen"]') as HTMLButtonElement).click();
      });

      expect(layer.style.transform).toBe("translate(0px, 0px) scale(1)");
    });
  });

  describe("search", () => {
    it("lists matches and jumps to the picked agent", async () => {
      const { layer } = await renderOrgChart();
      const input = await typeSearch("engin");

      const options = [...container.querySelectorAll('[role="option"]')].map((o) => o.textContent);
      expect(options).toEqual([expect.stringContaining("Engineer")]);

      await act(async () => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      await flushReact();

      expect(document.activeElement).toBe(card(container, "agent-2"));
      expect(input.value).toBe("");
      // Engineer card (x 60, y 260) is centred in the 420 x 620 viewport.
      expect(layer.style.transform).toBe(`translate(${210 - (60 + 124)}px, ${310 - (260 + 68)}px) scale(1)`);
    });

    it("expands a collapsed branch to show the found agent", async () => {
      await renderOrgChart();
      await act(async () => {
        (card(container, "agent-1")!.querySelector("[data-org-toggle]") as HTMLButtonElement).click();
      });
      expect(card(container, "agent-2")).toBeNull();

      await typeSearch("Engineer");
      await act(async () => {
        (container.querySelector('[role="option"] button') as HTMLButtonElement).click();
      });
      await flushReact();

      expect(card(container, "agent-2")).not.toBeNull();
      expect(document.activeElement).toBe(card(container, "agent-2"));
    });

    it("says so when nothing matches", async () => {
      await renderOrgChart();
      await typeSearch("zzz");
      expect(container.textContent).toContain("No agent matches");
    });
  });

  describe("collapse and keyboard", () => {
    it("collapses and expands a branch", async () => {
      await renderOrgChart();
      const toggle = card(container, "agent-1")!.querySelector("[data-org-toggle]") as HTMLButtonElement;
      expect(toggle.getAttribute("aria-expanded")).toBe("true");

      await act(async () => toggle.click());
      expect(card(container, "agent-2")).toBeNull();
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(container.querySelectorAll('[data-testid="org-chart-edges"] path')).toHaveLength(0);
      // Toggling does not open the side panel.
      expect(document.querySelector('[role="dialog"]')).toBeNull();

      await act(async () => toggle.click());
      expect(card(container, "agent-2")).not.toBeNull();
    });

    it("moves between cards with the arrow keys", async () => {
      await renderOrgChart();
      const ceo = card(container, "agent-1")!;
      expect(ceo.tabIndex).toBe(0);
      expect(card(container, "agent-2")!.tabIndex).toBe(-1);

      await act(async () => {
        ceo.focus();
        ceo.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      });
      expect(document.activeElement).toBe(card(container, "agent-2"));
      expect(card(container, "agent-2")!.tabIndex).toBe(0);

      await act(async () => {
        card(container, "agent-2")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
      });
      expect(document.activeElement).toBe(ceo);
    });

    it("opens the side panel with Enter", async () => {
      await renderOrgChart();
      await act(async () => {
        card(container, "agent-2")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      await flushReact();
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Engineer");
    });
  });

  describe("card detail and side panel", () => {
    it("shows live status, current task, open count and last run", async () => {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-04-02T12:00:00.000Z") });
      listMock.mockResolvedValue([
        { ...agents[0], status: "paused", pauseReason: "budget", lastHeartbeatAt: new Date("2026-04-02T11:55:00.000Z") },
        { ...agents[1], status: "error", errorReason: "Adapter login expired" },
      ]);
      issuesMock.mockResolvedValue([
        { id: "i-1", identifier: "GRE-1", title: "Ship the board", status: "in_progress", assigneeAgentId: "agent-1" },
        { id: "i-2", identifier: "GRE-2", title: "Plan Q3", status: "todo", assigneeAgentId: "agent-1" },
      ]);
      await renderOrgChart();
      vi.useRealTimers();

      const ceo = card(container, "agent-1")!;
      expect(ceo.textContent).toContain("Paused · budget limit reached");
      expect(ceo.textContent).toContain("GRE-1 Ship the board");
      expect(ceo.textContent).toContain("2 open · ran 5m ago");

      const engineer = card(container, "agent-2")!;
      expect(engineer.textContent).toContain("Error · Adapter login expired");
      expect(engineer.textContent).toContain("No current task");
      expect(engineer.textContent).toContain("0 open · never ran");
    });

    it("marks an agent with a live run as running on its run's task", async () => {
      issuesMock.mockResolvedValue([
        { id: "i-1", identifier: "GRE-1", title: "First", status: "in_progress", assigneeAgentId: "agent-2" },
        { id: "i-2", identifier: "GRE-2", title: "Second", status: "in_progress", assigneeAgentId: "agent-2" },
      ]);
      liveRunsMock.mockResolvedValue([{ id: "run-1", agentId: "agent-2", status: "running", issueId: "i-2" }]);
      await renderOrgChart();

      const engineer = card(container, "agent-2")!;
      expect(engineer.querySelector('[data-testid="org-card-status"]')?.textContent).toBe("Running");
      expect(engineer.textContent).toContain("GRE-2 Second");
    });

    it("opens a side panel on tap, with a link to the agent page", async () => {
      const { viewport } = await renderOrgChart();

      await act(async () => {
        viewport.dispatchEvent(createTouchEvent("touchstart", [{ clientX: 100, clientY: 100 }]));
        viewport.dispatchEvent(createTouchEvent("touchend", []));
        card(container, "agent-1")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      await flushReact();

      const panel = document.querySelector('[role="dialog"]') as HTMLElement;
      expect(panel.textContent).toContain("CEO");
      expect(panel.textContent).toContain("Spend this month");
      expect(navigateMock).not.toHaveBeenCalled();

      const openButton = [...panel.querySelectorAll("button")].find((b) => b.textContent === "Open agent page")!;
      await act(async () => openButton.click());
      expect(navigateMock).toHaveBeenCalledWith("/agents/ceo");
    });
  });

  describe("page actions", () => {
    it("shows both portability buttons on self-hosted instances", async () => {
      await renderOrgChart();

      expect(container.textContent).toContain("Import organization");
      expect(container.textContent).toContain("Export organization");
    });

    it("hides the Import button but keeps Export on a Cloud-managed instance", async () => {
      queryClient.setQueryData(queryKeys.health, { status: "ok", cloud: { managed: true } });
      await renderOrgChart();

      expect(container.textContent).not.toContain("Import organization");
      expect(container.textContent).toContain("Export organization");
    });
  });

  describe("teams", () => {
    const team = (id: string, name: string, color: string, memberAgentIds: string[], leadAgentId: string | null = null) => ({
      id,
      companyId: "company-1",
      name,
      color,
      description: null,
      leadAgentId,
      memberAgentIds,
      createdAt: "2026-10-02T00:00:00Z",
      updatedAt: "2026-10-02T00:00:00Z",
    });

    function viewButton(label: string) {
      return [...container.querySelectorAll('[aria-label="Chart view"] button')].find(
        (b) => b.textContent === label,
      ) as HTMLButtonElement | undefined;
    }

    it("shows no team view switch when the company has no teams", async () => {
      await renderOrgChart();
      expect(container.querySelector('[aria-label="Chart view"]')).toBeNull();
      expect(container.querySelector('[data-testid="org-card-teams"]')).toBeNull();
    });

    it("colours cards by team in the reporting-line view", async () => {
      teamsMock.mockResolvedValue([
        team("t-eng", "Engineering", "#2563eb", ["agent-2"]),
        team("t-lead", "Leadership", "#dc2626", ["agent-1", "agent-2"]),
      ]);
      await renderOrgChart();

      const stripe = card(container, "agent-2")!.querySelector('[data-testid="org-card-teams"]') as HTMLElement;
      expect(stripe.title).toBe("Teams: Engineering, Leadership");
      expect(stripe.children).toHaveLength(2);
      expect(card(container, "agent-2")!.getAttribute("aria-label")).toContain("teams: Engineering, Leadership");
      // Reporting lines are still drawn.
      expect(container.querySelectorAll('[data-testid="org-chart-edges"] path')).toHaveLength(1);
    });

    it("groups agents into coloured team boxes without reporting lines", async () => {
      teamsMock.mockResolvedValue([team("t-eng", "Engineering", "#2563eb", ["agent-1", "agent-2"], "agent-1")]);
      await renderOrgChart();

      await act(async () => viewButton("Group by team")!.click());
      await flushReact();

      expect(viewButton("Group by team")!.getAttribute("aria-pressed")).toBe("true");
      const boxes = [...container.querySelectorAll('[data-testid="org-team-box"]')] as HTMLElement[];
      expect(boxes.map((b) => b.getAttribute("data-team-id"))).toEqual(["t-eng"]);
      expect(boxes[0]!.textContent).toContain("Engineering");
      expect(boxes[0]!.textContent).toContain("Lead: CEO");
      expect(boxes[0]!.style.borderColor).not.toBe("");
      expect(container.querySelectorAll('[data-testid="org-chart-edges"] path')).toHaveLength(0);
      expect(card(container, "agent-2")).not.toBeNull();

      await act(async () => viewButton("Reporting lines")!.click());
      expect(container.querySelector('[data-testid="org-team-box"]')).toBeNull();
      expect(container.querySelectorAll('[data-testid="org-chart-edges"] path')).toHaveLength(1);
    });

    it("shows an agent in two teams in both boxes, and real reporting lines in the panel", async () => {
      teamsMock.mockResolvedValue([
        team("t-a", "Alpha", "#2563eb", ["agent-2"]),
        team("t-b", "Beta", "#16a34a", ["agent-2"]),
      ]);
      await renderOrgChart();
      await act(async () => viewButton("Group by team")!.click());
      await flushReact();

      const engineerCards = container.querySelectorAll('[data-agent-id="agent-2"]');
      expect(engineerCards).toHaveLength(2);
      const boxIds = [...container.querySelectorAll('[data-testid="org-team-box"]')].map((b) => b.getAttribute("data-team-id"));
      expect(boxIds).toEqual(["t-a", "t-b", "none"]);

      await act(async () => {
        engineerCards[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      await flushReact();

      const panel = document.querySelector('[role="dialog"]') as HTMLElement;
      expect(panel.textContent).toContain("Reports toCEO");
      expect(panel.textContent).toContain("Alpha");
      expect(panel.textContent).toContain("Beta");
    });
  });
});
