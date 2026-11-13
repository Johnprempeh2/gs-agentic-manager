// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../lib/queryKeys";
import { SidebarAccountMenu } from "./SidebarAccountMenu";
import { CUSTOMISE_SIDEBAR_EVENT } from "../lib/sidebar-layout";
import { TooltipProvider } from "@/components/ui/tooltip";

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
  signInEmail: vi.fn(),
  signUpEmail: vi.fn(),
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
  signOut: vi.fn(),
}));
const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));
const mockToggleTheme = vi.hoisted(() => vi.fn());
const mockSetSidebarOpen = vi.hoisted(() => vi.fn());
const mockNavigateTopLevel = vi.hoisted(() => vi.fn());

vi.mock("@/api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("@/lib/browserNavigation", () => ({
  navigateTopLevel: mockNavigateTopLevel,
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
    setSidebarOpen: mockSetSidebarOpen,
  }),
}));

const mockCanRelease = vi.hoisted(() => vi.fn(() => false));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: "company-1", name: "Greatstone", issuePrefix: "GRE" },
    selectedCompanyId: "company-1",
  }),
}));

vi.mock("../hooks/useReleases", () => ({
  useCanRelease: () => ({ canRelease: mockCanRelease() }),
}));

// The company switcher has its own tests; here it is the row that opens it.
vi.mock("./SidebarCompanyMenu", () => ({
  SidebarCompanyMenu: ({ inMenu }: { inMenu?: boolean }) => (
    <button type="button" data-testid="company-switch-row" data-in-menu={inMenu ? "true" : "false"}>
      Greatstone Switch
    </button>
  ),
}));

vi.mock("../context/ThemeContext", () => ({
  useTheme: () => ({
    theme: "dark",
    toggleTheme: mockToggleTheme,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  await callback();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("SidebarAccountMenu", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: {
        id: "user-1",
        name: "Jane Example",
        email: "jane@example.com",
        image: "https://example.com/jane.png",
      },
    });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: false,
    });
    mockAuthApi.signOut.mockResolvedValue({ success: true, redirectTo: "/cloud/logout" });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("rests on the glass panel with a hairline above it", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <SidebarAccountMenu deploymentMode="local_trusted" />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const accountSurface = container.firstElementChild;
    // Sidebar v2: no solid fill of its own, the liquid glass shows through.
    expect(accountSurface?.className).not.toContain("bg-sidebar");
    expect(accountSurface?.className).toContain("border-t");
    expect(accountSurface?.className).toContain("border-sidebar-border");
    expect(accountSurface?.className).not.toContain("border-r");
    const accountTrigger = container.querySelector('button[aria-label="Open account menu"]');
    expect(accountTrigger?.classList).toContain("rounded-xl");
    expect(accountTrigger?.classList).toContain("hover:bg-sidebar-accent");
    expect(accountTrigger?.classList).toContain("hover:text-sidebar-accent-foreground");
    expect(accountTrigger?.classList).not.toContain("hover:bg-background");

    const feedbackButton = container.querySelector<HTMLAnchorElement>(
      'a[aria-label="Email feedback to Greatstone"]',
    );
    // Feedback goes to Greatstone, never to the upstream project.
    expect(feedbackButton?.getAttribute("href")).toBe("mailto:info@greatstone.co.uk?subject=GS%20Agentic%20Manager%20feedback");
    expect(feedbackButton?.classList).toContain("text-subtle-foreground");
    expect(feedbackButton?.classList).not.toContain("text-border");
    expect(feedbackButton?.classList).not.toContain("text-muted-foreground");
    expect(feedbackButton?.classList).toContain("hover:bg-sidebar-accent");
    expect(feedbackButton?.classList).toContain("hover:text-sidebar-accent-foreground");
    expect(feedbackButton?.classList).not.toContain("hover:bg-background");
    expect(feedbackButton?.querySelector("svg")?.classList).toContain("lucide-flag");
    expect(feedbackButton?.getAttribute("data-slot")).toBe("tooltip-trigger");
    expect(feedbackButton?.hasAttribute("title")).toBe(false);

    await act(async () => root.unmount());
  });

  it("keeps authenticated self-hosted sign-out on the local auth flow", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(queryKeys.health, {
      status: "ok",
      deploymentMode: "authenticated",
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <SidebarAccountMenu deploymentMode="authenticated" />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.querySelector('a[aria-label="Email feedback to Greatstone"]')).not.toBeNull();
    expect(container.textContent).toContain("Jane Example");
    expect(container.textContent).not.toContain("jane@example.com");

    const trigger = container.querySelector('button[aria-label="Open account menu"]');
    expect(trigger).not.toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("Edit profile");
    expect(document.body.textContent).toContain("Company settings");
    expect(document.body.querySelector('a[href$="/tutorials"]')?.textContent).toContain("Tutorials");
    expect(document.body.textContent).not.toContain("Instance settings");
    // The upstream docs link is gone; there is no Greatstone docs site yet.
    expect(document.body.textContent).not.toContain("Documentation");

    const popover = document.body.querySelector('[data-slot="popover-content"]');
    expect(popover?.textContent).not.toContain("Feedback");
    expect(popover?.querySelector('a[href*="paperclip.ing"]')).toBeNull();

    // The popover header stays down to name + email: no "Account" badge, no version line.
    expect(popover?.textContent).not.toContain("Account");
    expect(popover?.textContent).not.toContain("GS Agentic Manager v");
    expect(document.body.textContent).toContain("jane@example.com");
    expect(document.body.querySelector('[data-slot="popover-content"]')?.className)
      .toContain("w-(--profile-popover-width)");
    expect(document.body.querySelector('[data-slot="popover-content"]')?.className)
      .toContain("rounded-xl");
    expect(document.body.querySelector('[data-slot="popover-content"]')?.className)
      .toContain("max-h-(--radix-popover-content-available-height)");
    expect(document.body.querySelector('a[href="/company/settings"]')?.className)
      .not.toContain("bg-muted");
    expect(document.body.textContent).not.toContain("Manage company and instance settings.");
    expect(document.body.textContent).not.toContain("Open your activity, task, and usage ledger.");
    expect(document.body.querySelector('a[href="/company/settings/instance/profile"]')).not.toBeNull();
    expect(document.body.querySelector('a[href="/company/settings"]')).not.toBeNull();

    const signOutButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Sign out"),
    );
    await act(async () => {
      signOutButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockAuthApi.signOut).toHaveBeenCalledOnce();
    expect(mockNavigateTopLevel).not.toHaveBeenCalled();
    expect(queryClient.getQueryState(queryKeys.health)?.isInvalidated).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });

  it("hides cloud feedback and signs out through the harness", async () => {
    const root = createRoot(container);
    const onOpenChange = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(queryKeys.health, {
      status: "ok",
      deploymentMode: "authenticated",
      cloud: {
        managed: true,
        managedBy: "paperclip-cloud",
        stackSlug: "acme-labs",
        cloudBaseUrl: "https://cloud.example.test",
      },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <SidebarAccountMenu
              deploymentMode="authenticated"
              open
              onOpenChange={onOpenChange}
            />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.querySelector('a[aria-label="Email feedback to Greatstone"]')).toBeNull();

    const signOutButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Sign out"),
    );
    await act(async () => {
      signOutButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockAuthApi.signOut).not.toHaveBeenCalled();
    expect(mockNavigateTopLevel).toHaveBeenCalledOnce();
    expect(mockNavigateTopLevel).toHaveBeenCalledWith("/cloud/logout");
    expect(onOpenChange).toHaveBeenCalledWith(false);

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps sign-out hidden outside authenticated deployment mode", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <SidebarAccountMenu deploymentMode="local_trusted" open />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(document.body.textContent).not.toContain("Sign out");

    await act(async () => {
      root.unmount();
    });
  });

  it("shows avatar, name and company, and holds every account action in v2 order", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockCanRelease.mockReturnValue(true);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <SidebarAccountMenu deploymentMode="authenticated" />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const trigger = container.querySelector('button[aria-label="Open account menu"]')!;
    expect(trigger.querySelector('[data-slot="avatar"]')).not.toBeNull();
    expect(trigger.textContent).toContain("Jane Example");
    expect(trigger.querySelector('[data-slot="account-company"]')?.textContent).toBe("Greatstone");

    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const popover = document.body.querySelector('[data-slot="popover-content"]')!;
    expect(popover.querySelector('[data-testid="company-switch-row"]')?.getAttribute("data-in-menu")).toBe("true");
    const labels = Array.from(popover.querySelectorAll("a, button"))
      .map((element) => element.textContent?.trim() ?? "")
      .filter(Boolean);
    const order = [
      "Greatstone Switch",
      "Your profile",
      "Notifications",
      "Customise menu",
      "Company settings",
      "Releases",
      "Tutorials",
      "What's new",
      "Sign out",
    ];
    const positions = order.map((label) => labels.findIndex((text) => text.startsWith(label)));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(labels.some((text) => /theme|mode/i.test(text))).toBe(true);
    expect(popover.querySelector('a[href="/releases"]')).not.toBeNull();
    expect(popover.querySelector('a[href="/whats-new"]')).not.toBeNull();

    await act(async () => root.unmount());
  });

  it("keeps Releases to the board", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockCanRelease.mockReturnValue(false);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <SidebarAccountMenu deploymentMode="authenticated" open />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(document.body.querySelector('a[href="/releases"]')).toBeNull();
    expect(document.body.querySelector('a[href="/tutorials"]')).not.toBeNull();

    await act(async () => root.unmount());
  });

  it("Customise menu closes the menu and asks the sidebar to start customising", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onOpenChange = vi.fn();
    const heard = vi.fn();
    window.addEventListener(CUSTOMISE_SIDEBAR_EVENT, heard);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <SidebarAccountMenu deploymentMode="authenticated" open onOpenChange={onOpenChange} />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const customise = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Customise menu"));
    await act(async () => {
      customise?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(heard).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    window.removeEventListener(CUSTOMISE_SIDEBAR_EVENT, heard);
    await act(async () => root.unmount());
  });

  it("never shows the local board user's placeholder address", async () => {
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "local-board" },
      user: { id: "local-board", name: "John Prempeh", email: "local@paperclip.local", image: null },
    });
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <SidebarAccountMenu deploymentMode="local_trusted" open />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(document.body.textContent).toContain("John Prempeh");
    expect(document.body.textContent).not.toContain("paperclip.local");

    await act(async () => {
      root.unmount();
    });
  });

});
