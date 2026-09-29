// @vitest-environment jsdom

import { type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { instanceExperimentalSettingsSchema } from "@greatstone/shared";
import { Sidebar } from "./Sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";

const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
}));

const mockAttentionApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
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

vi.mock("../api/attention", () => ({
  attentionApi: mockAttentionApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
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

vi.mock("./SidebarAgents", () => ({
  SidebarAgents: ({ streamlined }: { streamlined?: boolean }) => (
    <div data-testid="sidebar-agents" data-streamlined={String(streamlined)}>
      Active agents
    </div>
  ),
}));

vi.mock("./SidebarProjects", () => ({
  SidebarProjects: () => <div data-testid="sidebar-projects">Classic projects</div>,
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
    const section = [...container.querySelectorAll("nav > div")]
      .find((node) => node.textContent?.startsWith(label));
    return [...(section?.querySelectorAll("a") ?? [])].map((anchor) => anchor.textContent?.trim());
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
    mockAttentionApi.list.mockResolvedValue({ items: [] });
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

    flushSync(() => {
      root.unmount();
    });
  });

  it("shows Releases only to the board (GRE-122)", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    const releasesLink = () =>
      [...container.querySelectorAll("nav a")].find((anchor) => anchor.textContent?.trim() === "Releases");

    mockCanRelease.value = false;
    let root = await renderSidebar();
    expect(releasesLink()).toBeUndefined();
    flushSync(() => {
      root.unmount();
    });

    mockCanRelease.value = true;
    root = await renderSidebar();
    expect(releasesLink()?.getAttribute("href")).toBe("/releases");
    flushSync(() => {
      root.unmount();
    });
    mockCanRelease.value = false;
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

  it("renders plugin sidebar launchers inside the Build section", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: false,
      enableStreamlinedLeftNavigation: true,
    });
    const root = await renderSidebar();

    const launcher = [...container.querySelectorAll("nav [data-plugin-launcher-zone]")]
      .find((node) => node.getAttribute("data-plugin-launcher-zone") === "sidebar");
    expect(launcher?.textContent).toContain("Plugin launcher outlet");
    // Sections are Collapsibles (one extra wrapper level), so resolve the
    // section root by walking up until the header label appears.
    let buildSectionContainer = launcher?.parentElement ?? null;
    while (buildSectionContainer && !buildSectionContainer.textContent?.startsWith("Build")) {
      buildSectionContainer = buildSectionContainer.parentElement;
    }
    expect(buildSectionContainer?.textContent).toContain("Projects");
    expect(buildSectionContainer?.textContent).toContain("Routines");

    flushSync(() => {
      root.unmount();
    });
  });

  it("uses the simplified work navigation with one Agents destination", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: false,
      enableStreamlinedLeftNavigation: true,
    });
    const root = await renderSidebar();

    expect(container.textContent).toContain("New Task");
    expect(container.textContent).not.toContain("New Issue");

    const navLabels = [...container.querySelectorAll("nav a")].map((a) => a.textContent?.trim());
    expect(navLabels).toContain("Tasks");
    expect(navLabels).not.toContain("Issues");

    const projectsLink = [...container.querySelectorAll("nav a")].find((a) => a.textContent?.trim() === "Projects");
    expect(projectsLink?.getAttribute("href")).toBe("/projects");
    const agentLinks = [...container.querySelectorAll('a[href="/agents"]')];
    expect(agentLinks).toHaveLength(1);
    expect([...container.querySelectorAll('a[href="/activity"]')]).toHaveLength(1);
    expect(navLabels).toContain("Audit");
    expect(navLabels).not.toContain("Settings");
    expect(navLabels).not.toContain("Activity");
    expect(navLabels).not.toContain("Costs");
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
    expect(navLabels).toContain("Agents");
    expect(container.textContent).not.toContain("Organization");

    flushSync(() => {
      root.unmount();
    });
  });

  it("ignores the retired streamlined navigation opt-out", async () => {
    // PAP-12472 retired the experimental opt-out; the streamlined sidebar is the
    // only path, so an old `false` setting no longer restores classic mode.
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
    expect(navLabels).toContain("Agents");

    flushSync(() => {
      root.unmount();
    });
  });

  it("restores legacy agent and organization navigation when Streamlined UI is off", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableStreamlinedUi: false,
      enableApps: true,
    });
    const root = await renderSidebar();

    const labels = [...container.querySelectorAll("nav a")].map((anchor) => anchor.textContent?.trim());
    expect(container.querySelector('[data-testid="sidebar-recent-tasks"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-projects"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="sidebar-agents"]')?.getAttribute("data-streamlined")).toBe("undefined");
    expect(container.textContent).toContain("Organization");
    expect(labels).toEqual(expect.arrayContaining(["Org", "Connectors", "Timeline", "Costs", "Activity", "Settings"]));
    expect(labels).not.toContain("Audit");
    expect(labels).not.toContain("Projects");
    expect(container.querySelector('a[href="/agents"]')).toBeNull();
    expect(container.querySelector("aside")?.classList).toContain("border-r");

    flushSync(() => {
      root.unmount();
    });
  });

  it("locks the legacy collapse control while a secondary sidebar forces the rail", async () => {
    mockSidebar.collapseLocked = true;
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableStreamlinedUi: false });
    const root = await renderSidebar();

    expect(container.querySelector('button[aria-label="Collapse sidebar"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Expand sidebar"]')).toBeNull();

    flushSync(() => {
      root.unmount();
    });
  });

  it("renders plugin sidebar slots in Build below Workspaces", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    const root = await renderSidebar();

    const sidebarSlot = [...container.querySelectorAll("nav [data-plugin-slot-types]")]
      .find((node) => node.getAttribute("data-plugin-slot-types") === "sidebar");
    expect(sidebarSlot?.textContent).toContain("Plugin slot outlet");
    const buildSection = [...container.querySelectorAll("nav > div")]
      .find((section) => section.textContent?.startsWith("Build"));
    const buildText = buildSection?.textContent ?? "";
    expect(buildText).toContain("Workspaces");
    expect(buildText.indexOf("Workspaces")).toBeLessThan(buildText.indexOf("Plugin slot outlet"));

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

  it("shows Decisions with the default experimental settings (GRE-64)", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue(
      instanceExperimentalSettingsSchema.parse({}),
    );
    const root = await renderSidebar();

    expect(sectionLabels("Work")).toContain("Decisions");

    flushSync(() => {
      root.unmount();
    });
  });

  it("shows Decisions even when the stored setting is off (GRE-66)", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableDecisions: false });
    const root = await renderSidebar();

    const decisionsLink = container.querySelector('a[href="/decisions"]');
    expect(decisionsLink?.textContent?.trim()).toBe("Decisions");
    expect(sectionLabels("Work")).toContain("Decisions");
    expect(mockAttentionApi.list).toHaveBeenCalledWith("company-1");

    flushSync(() => {
      root.unmount();
    });
  });

  it("shows Status with its beta tag last in the Team section", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableStatusCards: true,
      enableConferenceRoomChat: true,
    });
    const root = await renderSidebar();

    const statusLink = container.querySelector('a[href="/status"]');
    expect(statusLink?.textContent).toContain("Status");
    expect(statusLink?.textContent).toContain("beta");
    expect(sectionLabels("Team")).toEqual(["Agents", "Conference Room", "Statusbeta"]);

    flushSync(() => {
      root.unmount();
    });
  });

  it("puts the Everest chat directly under Search (GRE-259)", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableAgentChat: true });
    const root = await renderSidebar();

    const top = container.querySelector("nav > div:first-child");
    expect(top?.textContent).toBe("New TaskSearchEverest");
    expect(top?.querySelector('section[aria-label="Chats"]')?.getAttribute("data-inline")).toBe("true");
    expect(container.querySelectorAll('section[aria-label="Chats"]')).toHaveLength(1);

    flushSync(() => {
      root.unmount();
    });
  });

  it("groups the streamlined navigation into Work, Team, Build and Company (GRE-259)", async () => {
    mockCanRelease.value = true;
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: true,
      enableCases: true,
      enableStatusCards: true,
      enableConferenceRoomChat: true,
    });
    const root = await renderSidebar();

    const headings = [...container.querySelectorAll("nav > div")]
      .map((section) => section.textContent)
      .flatMap((text) => ["Work", "Team", "Build", "Company"].filter((label) => text?.startsWith(label)));
    expect(headings).toEqual(["Work", "Team", "Build", "Company"]);
    expect(sectionLabels("Work")).toEqual(["Dashboard", "Inbox", "My tasks", "Decisions", "Tasks", "Goals"]);
    expect(sectionLabels("Team")).toEqual(["Agents", "Conference Room", "Statusbeta"]);
    expect(sectionLabels("Build")).toEqual(["Projects", "Routines", "Workspaces", "Artifacts", "Casesbeta"]);
    expect(sectionLabels("Company")).toEqual(["Skills", "Connectors", "Audit", "Releases"]);
    expect(
      container.querySelector('a[href="/issues"] svg')?.classList.contains("lucide-circle-check"),
    ).toBe(true);
    expect(container.textContent).not.toContain("Org");

    flushSync(() => {
      root.unmount();
    });
    mockCanRelease.value = false;
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

    expect(sectionLabels("Build")).toContain("Projects");
    expect(container.querySelector('a[href="/timeline"]')).toBeNull();

    flushSync(() => {
      root.unmount();
    });
  });

  it("shows the Conference Room nav item when conference room chat is enabled (PAP-137)", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: false,
      enableConferenceRoomChat: true,
    });
    const root = await renderSidebar();

    const link = [...container.querySelectorAll("nav a")].find(
      (anchor) => anchor.textContent?.trim() === "Conference Room",
    );
    expect(link?.getAttribute("href")).toBe("/board-chat");

    flushSync(() => {
      root.unmount();
    });
  });

  it("hides the Conference Room nav item when conference room chat is off (PAP-137)", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: false,
      enableConferenceRoomChat: false,
    });
    const root = await renderSidebar();

    expect(container.textContent).not.toContain("Conference Room");

    flushSync(() => {
      root.unmount();
    });
  });

  it("does not flash the Conference Room item while experimental settings are loading (PAP-137)", async () => {
    mockInstanceSettingsApi.getExperimental.mockImplementation(() => new Promise(() => {}));
    const root = await renderSidebar();

    expect(container.textContent).not.toContain("Conference Room");

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

  it("always shows Connectors in the Company section", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableApps: false });
    const root = await renderSidebar();

    const links = [...container.querySelectorAll("a")];
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

    const link = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent === "Pipelines");
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
    const root = await renderSidebar();

    const link = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent === "Workspaces");
    expect(link?.getAttribute("href")).toBe("/workspaces");

    flushSync(() => {
      root.unmount();
    });
  });

  it("does not render a global navigation collapse affordance", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    const root = await renderSidebar();

    expect(container.querySelector('button[aria-label="Collapse sidebar"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Expand sidebar"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Keep sidebar expanded"]')).toBeNull();
    expect(container.textContent).toContain("Company menu");

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
