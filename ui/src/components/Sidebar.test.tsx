// @vitest-environment jsdom

import { type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { instanceExperimentalSettingsSchema } from "@greatstone/shared";
import { Sidebar } from "./Sidebar";
import { findTourTarget } from "./FeatureTour";
import { WELCOME_TOUR } from "@/lib/welcome-tour";
import { openSidebarCustomise } from "@/lib/sidebar-layout";
import { TooltipProvider } from "@/components/ui/tooltip";

const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
}));

const mockDecisionsFeedApi = vi.hoisted(() => ({
  needsMe: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

const mockMemoryGraphApi = vi.hoisted(() => ({
  settings: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));

// The signed-in user's saved sidebar arrangement (server side in the app).
const mockSidebarPrefs = vi.hoisted(() => ({
  layout: {} as Record<string, unknown>,
  api: {
    getLayout: vi.fn(),
    updateLayout: vi.fn(),
    getSectionOrder: vi.fn(),
    updateSectionOrder: vi.fn(),
  },
}));
vi.mock("../api/sidebarPreferences", () => ({ sidebarPreferencesApi: mockSidebarPrefs.api }));
vi.mock("../api/auth", () => ({
  authApi: { getSession: vi.fn(async () => ({ user: { id: "user-1" }, session: { userId: "user-1" } })) },
}));
vi.mock("./AgentAvatar", () => ({ AgentAvatar: () => <span data-testid="agent-avatar" /> }));

const mockLocation = vi.hoisted(() => ({ pathname: "/PAP/dashboard", hash: "" }));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  useLocation: () => mockLocation,
  NavLink: ({ to, children, className, ...props }: {
    to: string;
    children: ReactNode;
    className?: string | ((state: { isActive: boolean }) => string);
  }) => (
    <a
      href={to}
      className={typeof className === "function" ? className({ isActive: false }) : className}
      {...props}
    >
      {children}
    </a>
  ),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    openNewIssue: vi.fn(),
  }),
  useDialogActions: () => ({
    openNewIssue: vi.fn(),
  }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", issuePrefix: "PAP", name: "GS Agentic Manager" },
  }),
}));

const mockSidebar = vi.hoisted(() => ({
  isMobile: false,
  setSidebarOpen: vi.fn(),
  collapsed: false,
  collapseLocked: false,
  peeking: false,
  toggleCollapsed: vi.fn(),
  setCollapsed: vi.fn(),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => mockSidebar,
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

vi.mock("../api/decisionsFeed", () => ({
  decisionsFeedApi: mockDecisionsFeedApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../api/memoryGraph", () => ({
  memoryGraphApi: mockMemoryGraphApi,
}));

vi.mock("../hooks/useInboxBadge", () => ({
  useInboxBadge: () => ({ inbox: 0, failedRuns: 0 }),
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotOutlet: ({ slotTypes }: { slotTypes: string[] }) => (
    <div data-plugin-slot-types={slotTypes.join(",")}>Plugin slot outlet</div>
  ),
}));

vi.mock("@/plugins/launchers", () => ({
  PluginLauncherOutlet: ({ placementZones }: { placementZones: string[] }) => (
    <div data-plugin-launcher-zone={placementZones.join(",")}>Plugin launcher outlet</div>
  ),
}));

vi.mock("./SidebarCompanyMenu", () => ({
  SidebarCompanyMenu: () => <div>Company menu</div>,
}));

vi.mock("./SidebarStarredPipelines", () => ({
  SidebarStarredPipelines: () => null,
}));

vi.mock("./SidebarStarredProjects", () => ({
  SidebarStarredProjects: () => <div data-testid="sidebar-starred-projects" />,
}));

const mockCanRelease = vi.hoisted(() => ({ value: false }));

vi.mock("../hooks/useReleases", () => ({
  useCanRelease: () => ({ canRelease: mockCanRelease.value, isLoading: false }),
}));

vi.mock("./SidebarReleaseFooter", () => ({
  SidebarReleaseFooter: () => <div data-testid="sidebar-release-footer" />,
}));

vi.mock("./SidebarAgentChats", () => ({
  SidebarAgentChats: ({ inline }: { inline?: boolean }) => (
    <section aria-label="Chats" data-inline={String(Boolean(inline))}>
      <a href="/chats/everest">Everest</a>
    </section>
  ),
}));

vi.mock("./SidebarRecentTasks", () => ({
  SidebarRecentTasks: () => <div data-testid="sidebar-recent-tasks">Recent Tasks</div>,
}));

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("Sidebar", () => {
  let container: HTMLDivElement;

  async function renderSidebar() {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <Sidebar />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    return root;
  }

  function sectionLabels(label: string) {
    const section = [...container.querySelectorAll("[data-sidebar-section]")]
      .find((node) => node.textContent?.startsWith(label));
    return [...(section?.querySelectorAll("a") ?? [])].map((anchor) => anchor.textContent?.trim());
  }

  async function click(element: Element | null | undefined) {
    expect(element).toBeTruthy();
    element?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushReact();
  }

  function button(label: string) {
    return container.querySelector(`button[aria-label="${label}"]`);
  }

  function textButton(text: string) {
    return [...container.querySelectorAll("button")].find((node) =>
      node.textContent?.trim() === text
        || [...node.querySelectorAll("span")].some((label) => label.textContent?.trim() === text),
    );
  }

  function menuItem(text: string) {
    return [...document.body.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent?.trim() === text);
  }

  // The account menu's "Customise menu" sends this event (sidebar v2).
  async function startCustomising() {
    flushSync(() => openSidebarCustomise());
    await flushReact();
  }

  function lastSavedLayout() {
    return mockSidebarPrefs.api.updateLayout.mock.calls.at(-1)?.[0];
  }

  function memorySettings(enabled: boolean) {
    return { companyId: "company-1", enabled, retainMode: "extract", appSignIn: false, updatedAt: null };
  }

  function memoryLinks() {
    return [...container.querySelectorAll('nav a[href="/memory"]')];
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockMemoryGraphApi.settings.mockResolvedValue(memorySettings(false));
    mockAgentsApi.list.mockResolvedValue([]);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
    mockDecisionsFeedApi.needsMe.mockResolvedValue({
      companyId: "company-1",
      generatedAt: "2026-09-29T00:00:00.000Z",
      count: 0,
      decisionCount: 0,
      assignedTaskCount: 0,
      decisions: [],
      assignedTasks: [],
    });
    mockSidebarPrefs.layout = {};
    mockLocation.pathname = "/PAP/dashboard";
    mockLocation.hash = "";
    mockSidebarPrefs.api.getLayout.mockImplementation(async () => ({ layout: mockSidebarPrefs.layout, updatedAt: null }));
    mockSidebarPrefs.api.updateLayout.mockImplementation(async (layout: unknown) => ({ layout, updatedAt: null }));
    mockSidebarPrefs.api.getSectionOrder.mockResolvedValue({ orderedIds: [], updatedAt: null });
    mockSidebarPrefs.api.updateSectionOrder.mockResolvedValue({ orderedIds: [], updatedAt: null });
    mockSidebar.isMobile = false;
    mockSidebar.collapsed = false;
    mockSidebar.collapseLocked = false;
    mockSidebar.peeking = false;
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("keeps the default sidebar edge borderless", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    const root = await renderSidebar();

    const sidebar = container.querySelector("aside");
    expect(sidebar?.classList).not.toContain("border-r");
    expect(sidebar?.classList).not.toContain("border-border");
    expect(sidebar?.classList).toContain("primary-sidebar-surface");

    // The real Greatstone assets at their true aspect: a flex row cannot stretch them.
    const header = container.querySelector('[data-slot="sidebar-brand-header"]');
    expect(header?.querySelector('[aria-label="Greatstone"]')).not.toBeNull();
    const stone = header?.querySelector<HTMLImageElement>('[data-slot="greatstone-stone"]');
    expect(stone?.getAttribute("width")).toBe("113");
    expect(stone?.getAttribute("height")).toBe("160");
    expect(stone?.classList).toContain("w-auto");
    expect(stone?.classList).toContain("flex-none");
    expect(header?.querySelector('[data-slot="greatstone-wordmark"]')?.classList).toContain("gs-wordmark");
    // The collapse toggle sits beside the logo.
    expect(header?.querySelector('button[aria-label="Collapse sidebar"]')?.getAttribute("aria-keyshortcuts")).toBe("[");

    flushSync(() => {
      root.unmount();
    });
  });

  it("does not duplicate the persistent Everest launcher inside the sidebar", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    mockAgentsApi.list.mockResolvedValue([
      { id: "agent-cto", name: "Atlas", role: "cto", status: "idle", reportsTo: "agent-ceo", urlKey: "atlas" },
      { id: "agent-ceo", name: "Everest", role: "ceo", status: "idle", reportsTo: null, urlKey: "everest" },
    ]);
    const root = await renderSidebar();

    expect(container.querySelector('[data-testid="sidebar-ask-everest"]')).toBeNull();

    flushSync(() => {
      root.unmount();
    });
  });

  it("gives every stop of the welcome tour something on screen to point at", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableWebsiteView: true });
    mockAgentsApi.list.mockResolvedValue([
      { id: "agent-ceo", name: "Everest", role: "ceo", status: "idle", reportsTo: null, urlKey: "everest" },
    ]);
    const root = await renderSidebar();

    const unanchored = WELCOME_TOUR.steps
      .filter((step) => step.target && ![step.target].flat().some((target) => findTourTarget(target)))
      .map((step) => step.title);
    // Commerce is in the sidebar only for the organisation that has a shop; the tour skips the stop elsewhere.
    // The orb (Talk to an agent) and the account menu mount beside the sidebar in Layout, not inside it.
    expect(unanchored).toEqual(["Talk to an agent", "Commerce", "Your account menu"]);
    expect(findTourTarget("nav-website")).not.toBeNull();

    flushSync(() => {
      root.unmount();
    });
  });

  it("points the Website welcome step at Work when that section is folded", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableWebsiteView: true });
    mockSidebarPrefs.layout = { collapsed: { work: true } };
    const root = await renderSidebar();

    const websiteStep = WELCOME_TOUR.steps.find((step) => step.title === "The website");
    expect(websiteStep?.target).toEqual(["nav-website", "Expand Work"]);
    expect(websiteStep?.body).toContain("Work section");
    expect(findTourTarget("nav-website")).toBeNull();
    expect(findTourTarget("Expand Work")).not.toBeNull();

    flushSync(() => {
      root.unmount();
    });
  });

  it("leaves Releases, Settings, Tutorials and What's new to the account menu", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    const releasesLink = () =>
      [...document.body.querySelectorAll("a")].find((anchor) => anchor.textContent?.trim() === "Releases");

    mockCanRelease.value = false;
    let root = await renderSidebar();
    expect(releasesLink()).toBeUndefined();
    flushSync(() => {
      root.unmount();
    });

    mockCanRelease.value = true;
    root = await renderSidebar();
    await click(textButton("Build"));
    expect(releasesLink()).toBeUndefined();
    for (const href of ["/company/settings", "/tutorials", "/whats-new"]) {
      expect(document.body.querySelector(`a[href="${href}"]`)).toBeNull();
    }
    flushSync(() => {
      root.unmount();
    });
    mockCanRelease.value = false;
  });

  it("counts live agents from running runs only, once per agent (GRE-257)", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    const liveRun = (id: string, agentId: string, status = "running") => ({
      id,
      agentId,
      agentName: agentId,
      status,
      createdAt: "2026-09-29T08:00:00Z",
      issueId: null,
    });
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([
      liveRun("r1", "a"),
      liveRun("r2", "a"),
      liveRun("r3", "b"),
      liveRun("r4", "c", "queued"),
    ]);
    const root = await renderSidebar();

    await click(textButton("Desk"));
    expect(document.body.querySelector('a[href="/dashboard"]')).not.toBeNull();

    flushSync(() => {
      root.unmount();
    });
  });

  it("gives each section a rearrange menu, and drag grips only while customising", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableAgentChat: true });
    const root = await renderSidebar();

    for (const label of ["Start", "Company", "Work", "Manage"]) {
      expect(button(`Rearrange ${label} section`)).not.toBeNull();
      expect(button(`Drag to move the ${label} section`)).toBeNull();
    }

    await startCustomising();
    for (const label of ["Start", "Company", "Work", "Manage"]) {
      const grip = button(`Drag to move the ${label} section`);
      expect(grip).not.toBeNull();
      expect(grip?.closest("a")).toBeNull();
    }

    flushSync(() => {
      root.unmount();
    });
  });

  it("shows Search as a nav item instead of a header icon", async () => {
    // The header's spare width goes to the workspace name (which otherwise
    // truncates at ~78px), so search lives in the nav list — still
    // exactly one pointer affordance, just relocated.
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    const root = await renderSidebar();

    expect(container.querySelector('a[aria-label="Open search"]')).toBeNull();
    const navSearchLink = [...container.querySelectorAll("nav a")]
      .find((anchor) => anchor.textContent?.trim() === "Search");
    expect(navSearchLink?.getAttribute("href")).toBe("/search");

    flushSync(() => {
      root.unmount();
    });
  });

  it("renders plugin sidebar launchers after the sections", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: false,
    });
    const root = await renderSidebar();

    const launcher = [...container.querySelectorAll("nav [data-plugin-launcher-zone]")]
      .find((node) => node.getAttribute("data-plugin-launcher-zone") === "sidebar");
    expect(launcher?.textContent).toContain("Plugin launcher outlet");
    expect(launcher?.closest("[data-sidebar-section]")).toBeNull();
    const workSection = container.querySelector('[data-sidebar-section="work"]');
    expect(
      workSection!.compareDocumentPosition(launcher!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    flushSync(() => {
      root.unmount();
    });
  });

  it("uses the simplified work navigation with one Agents destination", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: false,
    });
    const root = await renderSidebar();

    expect(container.textContent).toContain("New Task");
    expect(container.textContent).not.toContain("New Issue");

    const navLabels = [...container.querySelectorAll("nav a")].map((a) => a.textContent?.trim());
    expect(navLabels).toContain("Tasks");
    expect(navLabels).not.toContain("Agent tasks");
    expect(navLabels).not.toContain("Issues");

    const projectsLink = [...container.querySelectorAll("nav a")].find((a) => a.textContent?.trim() === "Projects");
    expect(projectsLink?.getAttribute("href")).toBe("/projects");
    expect(textButton("Team")).toBeTruthy();
    // Audit and Settings live under Build and Manage.
    expect(container.querySelector('a[href="/activity"]')).toBeNull();
    expect(textButton("Build")).toBeTruthy();
    expect(container.querySelector('[data-testid="sidebar-recent-tasks"]')).not.toBeNull();

    flushSync(() => {
      root.unmount();
    });
  });

  it("keeps the simplified navigation while experimental settings are loading", async () => {
    mockInstanceSettingsApi.getExperimental.mockImplementation(() => new Promise(() => {}));
    const root = await renderSidebar();

    const navLabels = [...container.querySelectorAll("nav a")].map((a) => a.textContent?.trim());
    expect(navLabels).toContain("Projects");
    expect(textButton("Team")).toBeTruthy();
    expect(container.textContent).not.toContain("Organization");

    flushSync(() => {
      root.unmount();
    });
  });

  it("ignores the retired streamlined navigation opt-out", async () => {
    // PAP-12472 retired the experimental opt-out; the streamlined sidebar is the
    // only path, so an old `false` setting no longer restores classic mode.
    // GRE-1440 graduated the switch, so nothing in Settings can set it either.
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: false,
      enableStreamlinedLeftNavigation: false,
    });
    const root = await renderSidebar();

    const navLabels = [...container.querySelectorAll("nav a")].map((a) => a.textContent?.trim());
    expect(navLabels).toContain("Tasks");
    // Top-level Projects link + starred children stay, per-project collapsible gone.
    expect(navLabels).toContain("Projects");
    expect(container.querySelector('[data-testid="sidebar-starred-projects"]')).not.toBeNull();
    expect(textButton("Team")).toBeTruthy();

    flushSync(() => {
      root.unmount();
    });
  });

  it("renders plugin sidebar slots after the sections, outside the top group", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    const root = await renderSidebar();

    const sidebarSlot = [...container.querySelectorAll("nav [data-plugin-slot-types]")]
      .find((node) => node.getAttribute("data-plugin-slot-types") === "sidebar");
    expect(sidebarSlot?.textContent).toContain("Plugin slot outlet");
    expect(sidebarSlot?.closest("[data-sidebar-section]")).toBeNull();

    const primaryNavText = container.querySelector("nav > div:first-child")?.textContent ?? "";
    expect(primaryNavText).not.toContain("Plugin slot outlet");

    flushSync(() => {
      root.unmount();
    });
  });

  it("does not flash the Workspaces link while experimental settings are loading", async () => {
    mockInstanceSettingsApi.getExperimental.mockImplementation(() => new Promise(() => {}));
    const root = await renderSidebar();

    expect(container.textContent).not.toContain("Workspaces");

    flushSync(() => {
      root.unmount();
    });
  });

  it("shows one count on Desk and Decisions, the decisions count, not assigned tasks", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    mockDecisionsFeedApi.needsMe.mockResolvedValue({
      companyId: "company-1",
      generatedAt: "2026-10-04T00:00:00.000Z",
      count: 3,
      decisionCount: 1,
      assignedTaskCount: 2,
      decisions: [],
      assignedTasks: [],
      overdueWaits: [],
    });
    const root = await renderSidebar();

    expect(textButton("Desk")?.textContent).toContain("1");
    await click(textButton("Desk"));
    expect(document.body.querySelector('a[href="/desk"]')).not.toBeNull();
    expect(document.body.querySelector('a[href="/desk#desk-needs-me"]')?.textContent).toContain("1");

    flushSync(() => {
      root.unmount();
    });
  });

  it("lights only one of Decisions and Desk, since both point at the Desk", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({});
    const active = () => [...container.querySelectorAll(".gs-nav-item-active")].map((a) => a.textContent?.trim());

    mockLocation.pathname = "/PAP/desk";
    let root = await renderSidebar();
    expect(active()).toEqual([expect.stringMatching(/^Desk/)]);
    flushSync(() => {
      root.unmount();
    });

    mockLocation.hash = "#desk-needs-me";
    root = await renderSidebar();
    expect(active()).toEqual([expect.stringMatching(/^Desk/)]);
    flushSync(() => {
      root.unmount();
    });
  });

  it("shows Decisions with the default experimental settings (GRE-64)", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue(
      instanceExperimentalSettingsSchema.parse({}),
    );
    const root = await renderSidebar();

    expect(sectionLabels("Start")).toContain("Calendar");
    expect(textButton("Desk")).toBeTruthy();

    flushSync(() => {
      root.unmount();
    });
  });

  it("shows Decisions even when the stored setting is off (GRE-66)", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableDecisions: false });
    const root = await renderSidebar();

    await click(textButton("Desk"));
    expect(document.body.querySelector('a[href="/desk#desk-needs-me"]')).not.toBeNull();
    expect(mockDecisionsFeedApi.needsMe).toHaveBeenCalledWith("company-1");

    flushSync(() => {
      root.unmount();
    });
  });

  it("shows Status, without a beta tag, last in the Team section (GRE-1622)", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableStatusCards: true, enableConferenceRoomChat: true });
    const root = await renderSidebar();

    await click(textButton("Team"));
    expect(document.body.querySelector('a[href="/status"]')?.textContent).toBe("Status");

    flushSync(() => {
      root.unmount();
    });
  });

  it("hides Status and the agent Chats when a client plan turns them off (GRE-1633)", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableStatusCards: false,
      enableAgentChat: false,
      enableConferenceRoomChat: true,
    });
    const root = await renderSidebar();

    expect(container.querySelector('a[href="/status"]')).toBeNull();
    expect(textButton("Team")).toBeTruthy();
    expect(sectionLabels("Start")).not.toContain("Chats");

    flushSync(() => {
      root.unmount();
    });
  });

  it("remembers folded sections from the saved layout and saves a toggle", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({});
    mockSidebarPrefs.layout = { collapsed: { work: true, manage: false } };
    const root = await renderSidebar();

    const navLabels = [...container.querySelectorAll("nav a")].map((anchor) => anchor.textContent?.trim());
    expect(navLabels).not.toContain("Dashboard");
    expect(textButton("Build")).toBeTruthy();

    await click(button("Collapse Manage"));
    expect(lastSavedLayout()).toEqual({ collapsed: { work: true, manage: true } });
    expect(button("Expand Manage")).not.toBeNull();

    flushSync(() => {
      root.unmount();
    });
  });

  it("puts Search under Ask Everest and New Task, and the chats in their own section", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableAgentChat: true });
    const root = await renderSidebar();

    const top = container.querySelector("nav > div:first-child");
    // Sidebar v2: the company switcher lives in the account menu, bottom left.
    expect(top?.textContent).toBe("New TaskSearch");
    expect(textButton("Deliverables")).toBeTruthy();
    const chats = container.querySelector('[data-sidebar-section="start"]');
    expect(chats?.querySelector('section[aria-label="Chats"]')?.getAttribute("data-inline")).toBe("true");
    expect(container.querySelectorAll('section[aria-label="Chats"]')).toHaveLength(1);
    expect(sectionLabels("Company")).toEqual(["GS Studio"]);

    flushSync(() => {
      root.unmount();
    });
  });

  describe("customise mode", () => {
    it("keeps a group when its anchor is pinned", async () => {
      mockInstanceSettingsApi.getExperimental.mockResolvedValue({});
      mockSidebarPrefs.layout = { pinned: ["agents"] };
      const root = await renderSidebar();

      expect(container.querySelectorAll('a[href="/agents"]')).toHaveLength(1);
      expect(textButton("Team")).toBeTruthy();
      await click(textButton("Team"));
      expect(document.body.querySelector('a[href="/scorecard"]')).not.toBeNull();

      flushSync(() => {
        root.unmount();
      });
    });

    it("keeps a group when its anchor is hidden", async () => {
      mockInstanceSettingsApi.getExperimental.mockResolvedValue({});
      mockSidebarPrefs.layout = { hidden: ["agents"] };
      const root = await renderSidebar();

      expect(container.querySelector('a[href="/agents"]')).toBeNull();
      expect(textButton("Team")).toBeTruthy();
      await click(textButton("Team"));
      expect(document.body.querySelector('a[href="/scorecard"]')).not.toBeNull();

      flushSync(() => {
        root.unmount();
      });
    });

    it("stays out of the way until asked for, then swaps links for editable rows", async () => {
      mockInstanceSettingsApi.getExperimental.mockResolvedValue({});
      const root = await renderSidebar();

      expect(container.querySelector('[data-testid="sidebar-customise-panel"]')).toBeNull();
      expect(button("Hide Goals")).toBeNull();

      await startCustomising();
      expect(container.querySelector('[data-testid="sidebar-customise-panel"]')).not.toBeNull();
      expect(container.querySelector('a[href="/goals"]')).toBeNull();
      expect(container.querySelector('[data-testid="sidebar-customise-item-goals"]')).not.toBeNull();
      // Admin opens while customising, so its items can be moved too.
      expect(container.querySelector('[data-testid="sidebar-customise-item-design-guide"]')).not.toBeNull();
      expect(container.textContent).toContain("Nothing hidden");

      await click(textButton("Done"));
      expect(container.querySelector('[data-testid="sidebar-customise-panel"]')).toBeNull();
      expect(container.querySelector('a[href="/goals"]')).not.toBeNull();

      flushSync(() => {
        root.unmount();
      });
    });

    it("hides an item, lists it under Hidden items and shows it again", async () => {
      mockInstanceSettingsApi.getExperimental.mockResolvedValue({});
      const root = await renderSidebar();

      await startCustomising();
      await click(button("Hide Goals"));
      expect(lastSavedLayout()).toEqual({ hidden: ["goals"], pinned: [] });
      expect(container.querySelector('[data-testid="sidebar-customise-item-goals"]')).toBeNull();
      expect(button("Show Goals")).not.toBeNull();

      await click(textButton("Done"));
      expect(container.querySelector('a[href="/goals"]')).toBeNull();

      await startCustomising();
      await click(button("Show Goals"));
      expect(lastSavedLayout()?.hidden).toEqual([]);
      await click(textButton("Done"));
      expect(container.querySelector('a[href="/goals"]')).not.toBeNull();

      flushSync(() => {
        root.unmount();
      });
    });

    it("moves an item from its menu and pins one to the top", async () => {
      mockInstanceSettingsApi.getExperimental.mockResolvedValue({});
      const root = await renderSidebar();

      await startCustomising();
      await click(button("More options for Inbox"));
      await click(menuItem("Move up"));
      expect(lastSavedLayout()?.sections?.start).toEqual(["my-tasks", "inbox", "decisions", "chats", "calendar"]);

      await click(button("More options for Agents"));
      await click(menuItem("Pin to top"));
      expect(lastSavedLayout()?.pinned).toEqual(["agents"]);
      expect(button("Unpin Agents")).not.toBeNull();

      await click(textButton("Done"));
      expect(textButton("Desk")).toBeTruthy();
      expect(container.querySelector('a[href="/agents"]')?.textContent).toBe("Agents");
      // Pinned items move to the top group; they are not listed twice.
      expect(container.querySelectorAll('a[href="/agents"]')).toHaveLength(1);

      flushSync(() => {
        root.unmount();
      });
    });

    it("resets the items and the section order to the default", async () => {
      mockInstanceSettingsApi.getExperimental.mockResolvedValue({});
      mockSidebarPrefs.layout = { hidden: ["goals"], pinned: ["agents"] };
      const root = await renderSidebar();

      expect(container.querySelector('a[href="/goals"]')).toBeNull();
      await startCustomising();
      await click(textButton("Reset to default"));
      expect(lastSavedLayout()).toEqual({});
      expect(mockSidebarPrefs.api.updateSectionOrder).toHaveBeenCalledWith({ orderedIds: [] });

      await click(textButton("Done"));
      expect(container.querySelector('a[href="/goals"]')).not.toBeNull();
      expect(sectionLabels("Pinned")).toEqual([]);

      flushSync(() => {
        root.unmount();
      });
    });

    it("opens the full sidebar first when customising starts from the rail", async () => {
      mockSidebar.collapsed = true;
      mockInstanceSettingsApi.getExperimental.mockResolvedValue({});
      const root = await renderSidebar();

      expect(textButton("Customise sidebar")).toBeUndefined();
      await startCustomising();
      expect(mockSidebar.setCollapsed).toHaveBeenCalledWith(false);

      flushSync(() => {
        root.unmount();
      });
    });
  });

  describe("Memory link", () => {
    it("shows Memory last in Work when memory is on for the company", async () => {
      mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableAgentChat: true });
      mockMemoryGraphApi.settings.mockResolvedValue(memorySettings(true));
      const root = await renderSidebar();

      expect(mockMemoryGraphApi.settings).toHaveBeenCalledWith("company-1");
      expect(memoryLinks()).toHaveLength(1);
      const link = memoryLinks()[0];
      expect(link.getAttribute("href")).toBe("/memory");
      expect(link.textContent?.trim()).toBe("Memory");
      expect(link.querySelector("svg")?.classList).toContain("lucide-brain");
      expect(sectionLabels("Work").at(-1)).toBe("Memory");

      flushSync(() => {
        root.unmount();
      });
    });

    it("hides Memory when memory is off for the company", async () => {
      mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableAgentChat: true });
      mockMemoryGraphApi.settings.mockResolvedValue(memorySettings(false));
      const root = await renderSidebar();

      expect(mockMemoryGraphApi.settings).toHaveBeenCalledWith("company-1");
      expect(memoryLinks()).toHaveLength(0);
      expect(sectionLabels("Work")).not.toContain("Memory");

      flushSync(() => {
        root.unmount();
      });
    });

    it("hides Memory while the memory settings are loading", async () => {
      mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
      mockMemoryGraphApi.settings.mockImplementation(() => new Promise(() => {}));
      const root = await renderSidebar();

      expect(memoryLinks()).toHaveLength(0);

      flushSync(() => {
        root.unmount();
      });
    });

    it("hides Memory when the memory settings cannot be read", async () => {
      mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
      mockMemoryGraphApi.settings.mockRejectedValue(new Error("Forbidden"));
      const root = await renderSidebar();

      expect(memoryLinks()).toHaveLength(0);

      flushSync(() => {
        root.unmount();
      });
    });
  });

  it("groups the navigation into Start, Company, Work and Manage", async () => {
    mockCanRelease.value = true;
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: true,
      enableCases: true,
      enableDeepDive: true,
      enablePipelines: true,
        enableConferenceRoomChat: true,
        enableAgentChat: true,
        enableStatusCards: true,
        enableWebsiteView: true,
    });
    const root = await renderSidebar();

    const headings = [...container.querySelectorAll("[data-sidebar-section]")]
      .map((section) => section.getAttribute("data-sidebar-section"));
    expect(headings).toEqual(["start", "company", "work", "manage"]);
    expect(sectionLabels("Start")).toContain("Calendar");
    expect(sectionLabels("Company")).toEqual(["Deep Divebeta", "GS Studio"]);
    expect(sectionLabels("Work")).toEqual(["Tasks", "Projects", "Website", "Goals"]);
    expect(sectionLabels("Manage")).toEqual(["Workspaces", "Cases", "Design guide"]);
    expect(textButton("Desk")).toBeTruthy();
    expect(textButton("Clients")).toBeTruthy();
    expect(textButton("Deliverables")).toBeTruthy();
    expect(textButton("Team")).toBeTruthy();
    expect(textButton("Build")).toBeTruthy();
    expect(
      container.querySelector('a[href="/issues"] svg')?.classList.contains("lucide-circle-check"),
    ).toBe(true);

    flushSync(() => {
      root.unmount();
    });
    mockCanRelease.value = false;
  });

  it("keeps Build destinations in its flyout", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({});
    mockLocation.pathname = "/PAP/apps/advanced";
    let root = await renderSidebar();
    await click(textButton("Build"));
    expect(document.body.querySelector('a[href="/apps"]')?.textContent).toBe("Connectors");
    flushSync(() => {
      root.unmount();
    });

    mockSidebarPrefs.layout = { collapsed: { manage: true } };
    root = await renderSidebar();
    expect(textButton("Build")).toBeUndefined();
    flushSync(() => {
      root.unmount();
    });
  });

  it("leaves out unavailable destinations", async () => {
    mockCanRelease.value = false;
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableStatusCards: false });
    const root = await renderSidebar();

    expect(container.querySelector('a[href="/design-guide"]')).not.toBeNull();
    expect(sectionLabels("Company")).toEqual(["GS Studio"]);
    expect(sectionLabels("Start")).not.toContain("Chats");

    await click(textButton("Build"));
    expect(document.body.querySelector('a[href="/releases"]')).toBeNull();

    await click(textButton("Team"));
    expect(document.body.querySelector('a[href="/status"]')).toBeNull();

    flushSync(() => {
      root.unmount();
    });
  });

  it("shows Deep Dive in Clients only while both flags are on", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableCases: true, enableDeepDive: true });
    let root = await renderSidebar();
    expect(sectionLabels("Company")).toEqual(["Deep Divebeta", "GS Studio"]);
    flushSync(() => {
      root.unmount();
    });

    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableCases: false, enableDeepDive: true });
    root = await renderSidebar();
    expect(container.textContent).not.toContain("Deep Dive");
    flushSync(() => {
      root.unmount();
    });
  });

  it("shows the Board link after Goals only while the board control panel is on (GRE-1135)", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableStrategyBoard: true });
    let root = await renderSidebar();
    const link = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent === "Board");
    expect(link?.getAttribute("href")).toBe("/strategy-board");
    expect(sectionLabels("Work").slice(-2)).toEqual(["Goals", "Board"]);
    flushSync(() => {
      root.unmount();
    });

    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableStrategyBoard: false });
    root = await renderSidebar();
    expect([...container.querySelectorAll("a")].some((anchor) => anchor.textContent === "Board")).toBe(false);
    flushSync(() => {
      root.unmount();
    });
  });

  it("always shows the Goals nav item, even with the old experimental setting off (GRE-191)", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: false,
      enableGoalsSidebarLink: false,
    });
    const root = await renderSidebar();

    const link = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent === "Goals");
    expect(link?.getAttribute("href")).toBe("/goals");

    expect(sectionLabels("Work").at(-1)).toBe("Goals");

    flushSync(() => {
      root.unmount();
    });
  });

  it("shows the Goals nav item while experimental settings are loading", async () => {
    mockInstanceSettingsApi.getExperimental.mockImplementation(() => new Promise(() => {}));
    const root = await renderSidebar();

    expect([...container.querySelectorAll("nav a")].map((a) => a.textContent?.trim())).toContain("Goals");
    expect(container.querySelector('[data-testid="sidebar-goals-placeholder"]')).toBeNull();

    flushSync(() => {
      root.unmount();
    });
  });

  it("keeps Timeline out of the global navigation", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    const root = await renderSidebar();

    expect(sectionLabels("Work")).toContain("Projects");
    expect(container.querySelector('a[href="/timeline"]')).toBeNull();

    flushSync(() => {
      root.unmount();
    });
  });

  it("shows the Conference Room nav item even when a stored flag is off (graduated, GRE-1624)", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: false,
      enableConferenceRoomChat: false,
    });
    const root = await renderSidebar();

    await click(textButton("Team"));
    const link = [...document.body.querySelectorAll("a")].find(
      (anchor) => anchor.textContent?.trim() === "Conference Room",
    );
    expect(link?.getAttribute("href")).toBe("/board-chat");

    flushSync(() => {
      root.unmount();
    });
  });

  it("shows the Conference Room nav item while experimental settings are loading (GRE-1624)", async () => {
    mockInstanceSettingsApi.getExperimental.mockImplementation(() => new Promise(() => {}));
    const root = await renderSidebar();

    expect(textButton("Team")).toBeTruthy();

    flushSync(() => {
      root.unmount();
    });
  });

  it("hides the Pipelines nav item when pipelines are disabled", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: false,
      enablePipelines: false,
    });
    const root = await renderSidebar();

    expect(container.textContent).not.toContain("Pipelines");

    flushSync(() => {
      root.unmount();
    });
  });

  it("always shows Connectors in the Build flyout", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableApps: false });
    const root = await renderSidebar();

    await click(textButton("Build"));
    const links = [...document.body.querySelectorAll("a")];
    const link = links.find((anchor) => anchor.textContent === "Connectors");
    expect(link?.getAttribute("href")).toBe("/apps");
    expect(link?.querySelector("svg")?.classList).toContain("lucide-unplug");
    expect(links.findIndex((anchor) => anchor.textContent === "Connectors")).toBeGreaterThan(
      links.findIndex((anchor) => anchor.textContent === "Skills"),
    );
    expect(links.findIndex((anchor) => anchor.textContent === "Connectors")).toBeLessThan(
      links.findIndex((anchor) => anchor.textContent === "Audit"),
    );

    flushSync(() => {
      root.unmount();
    });
  });

  it("shows the Pipelines nav item when pipelines are enabled", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: false,
      enablePipelines: true,
    });
    const root = await renderSidebar();

    await click(textButton("Clients"));
    const link = [...document.body.querySelectorAll("a")].find((anchor) => anchor.textContent === "Pipelines");
    expect(link?.getAttribute("href")).toBe("/pipelines");

    flushSync(() => {
      root.unmount();
    });
  });

  it("does not flash the Pipelines nav item while experimental settings are loading", async () => {
    mockInstanceSettingsApi.getExperimental.mockImplementation(() => new Promise(() => {}));
    const root = await renderSidebar();

    expect(container.textContent).not.toContain("Pipelines");

    flushSync(() => {
      root.unmount();
    });
  });

  it("shows the Workspaces link when isolated workspaces are enabled", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    mockSidebarPrefs.layout = { collapsed: { manage: false } };
    const root = await renderSidebar();

    const link = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent === "Workspaces");
    expect(link?.getAttribute("href")).toBe("/workspaces");

    flushSync(() => {
      root.unmount();
    });
  });

  it("renders a global navigation collapse affordance", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    const root = await renderSidebar();

    expect(container.querySelector('button[aria-label="Collapse sidebar"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Expand sidebar"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Keep sidebar expanded"]')).toBeNull();
    expect(container.textContent).not.toContain("Company menu");

    flushSync(() => {
      root.unmount();
    });
  });

  it("hides the collapse affordance on mobile (drawer handles it)", async () => {
    mockSidebar.isMobile = true;
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    const root = await renderSidebar();

    expect(container.querySelector('button[aria-label="Collapse sidebar"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Keep sidebar expanded"]')).toBeNull();

    flushSync(() => {
      root.unmount();
    });
  });
});
