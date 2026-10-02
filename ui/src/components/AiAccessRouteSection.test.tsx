// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AI_ACCESS_ROUTES, AI_ACCESS_ROUTE_DEFINITIONS } from "@greatstone/shared";
import { InstanceGeneralSettings } from "@/pages/InstanceGeneralSettings";

const mockAccessApi = vi.hoisted(() => ({ getCurrentBoardAccess: vi.fn() }));
const mockHealthApi = vi.hoisted(() => ({ get: vi.fn() }));
const mockInstanceSettingsApi = vi.hoisted(() => ({
  getGeneral: vi.fn(),
  updateGeneral: vi.fn(),
}));

vi.mock("@/api/access", () => ({ accessApi: mockAccessApi }));
vi.mock("@/api/health", () => ({ healthApi: mockHealthApi }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceSettingsApi }));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("AI access route control", () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let queryClient: QueryClient;
  let stored: Record<string, unknown>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stored = {
      censorUsernameInLogs: false,
      keyboardShortcuts: false,
      feedbackDataSharingPreference: "not_allowed",
      backupRetention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
      aiAccessRoute: "claude_subscription",
    };
    mockHealthApi.get.mockResolvedValue({ status: "ok", deploymentMode: "authenticated" });
    mockInstanceSettingsApi.getGeneral.mockImplementation(async () => ({ ...stored }));
    mockInstanceSettingsApi.updateGeneral.mockImplementation(async (patch: Record<string, unknown>) => {
      stored = { ...stored, ...patch };
      return { ...stored };
    });
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    queryClient.clear();
    container.remove();
    vi.clearAllMocks();
  });

  function render() {
    root = createRoot(container);
    flushSync(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <InstanceGeneralSettings embedded sections={["aiAccessRoute", "signOut"]} />
        </QueryClientProvider>,
      );
    });
  }

  function radios() {
    return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
  }

  function checkedLabel() {
    return radios().find((radio) => radio.getAttribute("aria-checked") === "true")
      ?.querySelector("div")?.textContent;
  }

  it("shows every server route plus the per-agent default, with the current route selected", async () => {
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({ isInstanceAdmin: true });
    render();

    await vi.waitFor(() => expect(radios()).toHaveLength(AI_ACCESS_ROUTES.length + 1));
    const labels = radios().map((radio) => radio.querySelector("div")?.textContent);
    expect(labels).toEqual([
      "Each agent's own setup",
      ...AI_ACCESS_ROUTES.map((route) => AI_ACCESS_ROUTE_DEFINITIONS[route].label),
    ]);
    for (const radio of radios()) {
      expect(radio.querySelectorAll("div")[1]?.textContent?.length).toBeGreaterThan(0);
    }
    expect(checkedLabel()).toBe("Claude subscription");
  });

  it("saves a new route and keeps it after a reload", async () => {
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({ isInstanceAdmin: true });
    render();
    await vi.waitFor(() => expect(radios().length).toBeGreaterThan(0));

    const codex = radios().find((radio) => radio.textContent?.includes("ChatGPT/Codex subscription"));
    flushSync(() => codex?.click());

    await vi.waitFor(() =>
      expect(mockInstanceSettingsApi.updateGeneral.mock.calls[0]?.[0]).toEqual({ aiAccessRoute: "codex_subscription" }),
    );
    await vi.waitFor(() => expect(checkedLabel()).toBe("ChatGPT/Codex subscription"));

    // Reload: a fresh cache reads the stored value back from the API.
    flushSync(() => root?.unmount());
    queryClient.clear();
    render();
    await vi.waitFor(() => expect(checkedLabel()).toBe("ChatGPT/Codex subscription"));
  });

  it("clears the route back to each agent's own setup", async () => {
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({ isInstanceAdmin: true });
    render();
    await vi.waitFor(() => expect(radios().length).toBeGreaterThan(0));

    flushSync(() => radios()[0]?.click());

    await vi.waitFor(() =>
      expect(mockInstanceSettingsApi.updateGeneral.mock.calls[0]?.[0]).toEqual({ aiAccessRoute: null }),
    );
  });

  it("hides the control from a non-admin", async () => {
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({ isInstanceAdmin: false });
    render();

    await vi.waitFor(() => expect(container.textContent).toContain("Sign out"));
    await vi.waitFor(() => expect(mockAccessApi.getCurrentBoardAccess).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="ai-access-route-section"]')).toBeNull();
  });
});
