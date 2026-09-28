// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { InstanceGeneralSettings } from "./InstanceGeneralSettings";

const mockAuthApi = vi.hoisted(() => ({ signOut: vi.fn() }));
const mockHealthApi = vi.hoisted(() => ({ get: vi.fn() }));
const mockInstanceSettingsApi = vi.hoisted(() => ({
  getGeneral: vi.fn(),
  updateGeneral: vi.fn(),
  getSystemMemory: vi.fn(),
  getRunAdmissionRecommendation: vi.fn(),
}));
const mockNavigateTopLevel = vi.hoisted(() => vi.fn());

vi.mock("@/api/auth", () => ({ authApi: mockAuthApi }));
vi.mock("@/api/health", () => ({ healthApi: mockHealthApi }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceSettingsApi }));
vi.mock("@/lib/browserNavigation", () => ({ navigateTopLevel: mockNavigateTopLevel }));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SELF_HOSTED_HEALTH = {
  status: "ok" as const,
  deploymentMode: "authenticated" as const,
  deploymentExposure: "private" as const,
  authReady: true,
  bootstrapStatus: "ready" as const,
  bootstrapInviteActive: false,
};

const CLOUD_HEALTH = {
  ...SELF_HOSTED_HEALTH,
  cloud: {
    managed: true as const,
    managedBy: "paperclip-cloud" as const,
    stackSlug: "acme",
    cloudBaseUrl: "https://cloud.example.test",
  },
};

describe("InstanceGeneralSettings sign-out", () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({
      censorUsernameInLogs: false,
      keyboardShortcuts: false,
      feedbackDataSharingPreference: "not_allowed",
      backupRetention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
    });
    mockInstanceSettingsApi.updateGeneral.mockResolvedValue(undefined);
    mockAuthApi.signOut.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    queryClient.clear();
    container.remove();
    vi.clearAllMocks();
  });

  async function renderPage(health: typeof SELF_HOSTED_HEALTH | typeof CLOUD_HEALTH) {
    mockHealthApi.get.mockResolvedValue(health);
    queryClient.setQueryData(queryKeys.health, health);
    root = createRoot(container);
    flushSync(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <InstanceGeneralSettings />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Deployment and auth"));
    expect(container.querySelector('[data-slot="card"]')).toBeNull();
  }

  function signOutButton() {
    return Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Sign out");
  }

  it("uses the Cloud-managed top-level logout without calling local auth", async () => {
    await renderPage(CLOUD_HEALTH);

    flushSync(() => signOutButton()?.click());

    await vi.waitFor(() => expect(mockNavigateTopLevel).toHaveBeenCalledOnce());
    expect(mockNavigateTopLevel).toHaveBeenCalledWith("/cloud/logout");
    expect(mockAuthApi.signOut).not.toHaveBeenCalled();
  });

  it("keeps authenticated self-hosted sign-out local and drops the account caches", async () => {
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    await renderPage(SELF_HOSTED_HEALTH);
    queryClient.setQueryData(queryKeys.auth.session, { session: { id: "session-1" } });
    queryClient.setQueryData(queryKeys.companies.all, {
      companies: [{ id: "company-a", name: "Account A Co" }],
      unauthorized: false,
    });

    flushSync(() => signOutButton()?.click());

    await vi.waitFor(() => expect(mockAuthApi.signOut).toHaveBeenCalledOnce());
    // Account-scoped entries are cleared outright, not marked stale — a stale
    // entry keeps serving the previous account's data until a refetch succeeds.
    await vi.waitFor(() =>
      expect(queryClient.getQueryData(queryKeys.auth.session)).toBeUndefined(),
    );
    expect(queryClient.getQueryData(queryKeys.companies.all)).toBeUndefined();
    // Health describes the instance, so it is refreshed rather than dropped.
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.health });
    expect(queryClient.getQueryData(queryKeys.health)).toEqual(SELF_HOSTED_HEALTH);
    expect(mockNavigateTopLevel).not.toHaveBeenCalled();
  });

  it("shows a current sign-out failure instead of a stale settings error", async () => {
    mockInstanceSettingsApi.updateGeneral.mockRejectedValue(new Error("Settings update failed"));
    mockAuthApi.signOut.mockRejectedValue(new Error("Sign-out request failed"));
    await renderPage(SELF_HOSTED_HEALTH);

    const censorToggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Toggle username log censoring"]',
    );
    flushSync(() => censorToggle?.click());
    await vi.waitFor(() => expect(container.textContent).toContain("Settings update failed"));

    flushSync(() => signOutButton()?.click());

    await vi.waitFor(() => expect(container.textContent).toContain("Sign-out request failed"));
    expect(container.textContent).not.toContain("Settings update failed");
  });

  it("clears a stale sign-out failure after a settings update succeeds", async () => {
    mockAuthApi.signOut.mockRejectedValue(new Error("Sign-out request failed"));
    await renderPage(SELF_HOSTED_HEALTH);

    flushSync(() => signOutButton()?.click());
    await vi.waitFor(() => expect(container.textContent).toContain("Sign-out request failed"));

    const censorToggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Toggle username log censoring"]',
    );
    flushSync(() => censorToggle?.click());

    await vi.waitFor(() => expect(mockInstanceSettingsApi.updateGeneral).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(container.textContent).not.toContain("Sign-out request failed"));
  });

  it("disables settings changes while sign-out is pending", async () => {
    let resolveSignOut: ((result: { success: boolean }) => void) | undefined;
    mockAuthApi.signOut.mockImplementation(
      () => new Promise<{ success: boolean }>((resolve) => {
        resolveSignOut = resolve;
      }),
    );
    await renderPage(SELF_HOSTED_HEALTH);

    const censorToggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Toggle username log censoring"]',
    );
    flushSync(() => signOutButton()?.click());
    await vi.waitFor(() => expect(mockAuthApi.signOut).toHaveBeenCalledOnce());

    expect(censorToggle?.disabled).toBe(true);
    flushSync(() => censorToggle?.click());
    expect(mockInstanceSettingsApi.updateGeneral).not.toHaveBeenCalled();

    resolveSignOut?.({ success: true });
    await vi.waitFor(() => expect(censorToggle?.disabled).toBe(false));
  });

  it("disables sign-out while a settings update is pending", async () => {
    let resolveSettings: (() => void) | undefined;
    mockInstanceSettingsApi.updateGeneral.mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveSettings = resolve;
      }),
    );
    await renderPage(SELF_HOSTED_HEALTH);

    const censorToggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Toggle username log censoring"]',
    );
    flushSync(() => censorToggle?.click());
    await vi.waitFor(() => expect(mockInstanceSettingsApi.updateGeneral).toHaveBeenCalledOnce());

    expect(signOutButton()?.disabled).toBe(true);
    flushSync(() => signOutButton()?.click());
    expect(mockAuthApi.signOut).not.toHaveBeenCalled();

    resolveSettings?.();
    await vi.waitFor(() => expect(signOutButton()?.disabled).toBe(false));
  });
});

describe("InstanceGeneralSettings operator-hidden sections", () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({
      censorUsernameInLogs: false,
      keyboardShortcuts: false,
      feedbackDataSharingPreference: "not_allowed",
      backupRetention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
    });
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    queryClient.clear();
    container.remove();
    vi.clearAllMocks();
  });

  async function renderPage(health: Record<string, unknown>) {
    mockHealthApi.get.mockResolvedValue(health);
    queryClient.setQueryData(queryKeys.health, health);
    root = createRoot(container);
    flushSync(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <InstanceGeneralSettings />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Backup retention"));
  }

  it("hides an operator-hidden field-backed section and a UI-only section", async () => {
    await renderPage({
      ...SELF_HOSTED_HEALTH,
      hiddenSettings: [
        "instance.general.censorUsernameInLogs",
        "instance.general.deploymentStatus",
      ],
    });

    expect(container.textContent).not.toContain("Censor username in logs");
    expect(container.textContent).not.toContain("Deployment and auth");
    expect(container.textContent).toContain("Backup retention");
    expect(container.textContent).toContain("AI feedback sharing");
    expect(container.textContent).toContain("Sign out");
  });

  it("shows every section when nothing is hidden", async () => {
    await renderPage(SELF_HOSTED_HEALTH);

    expect(container.textContent).toContain("Deployment and auth");
    expect(container.textContent).toContain("Censor username in logs");
    expect(container.textContent).toContain("Backup retention");
  });
});

const NO_USAGE_RECOMMENDATION = {
  windowDays: 7,
  current: { maxConcurrentRuns: 4, minAvailableMemoryMb: 3072 },
  suggested: { maxConcurrentRuns: 26, minAvailableMemoryMb: 3072 },
  reasons: ["No runs in the last 7 days; the suggestion uses the RAM rule only."],
  usage: {
    runsStarted: 0,
    peakConcurrentRuns: 0,
    holds: { globalCap: { runs: 0 }, lowMemory: { runs: 0 } },
  },
};

const USAGE_RECOMMENDATION = {
  ...NO_USAGE_RECOMMENDATION,
  suggested: { maxConcurrentRuns: 5, minAvailableMemoryMb: 3072 },
  reasons: [
    "RAM rule: (16384 MB total - 3072 MB floor) / 500 MB per run = 26 runs.",
    "4 runs waited on the run cap while free RAM stayed above the floor; raise the cap by one to 5.",
  ],
  usage: {
    runsStarted: 40,
    peakConcurrentRuns: 4,
    holds: { globalCap: { runs: 4 }, lowMemory: { runs: 0 } },
  },
};

describe("InstanceGeneralSettings run limits (GRE-114)", () => {
  const GB = 1024 * 1024 * 1024;
  let container: HTMLDivElement;
  let root: Root | null;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({
      censorUsernameInLogs: false,
      keyboardShortcuts: false,
      feedbackDataSharingPreference: "not_allowed",
      backupRetention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
      runAdmission: { maxConcurrentRuns: 4, minAvailableMemoryMb: 3072 },
    });
    mockInstanceSettingsApi.updateGeneral.mockResolvedValue(undefined);
    mockInstanceSettingsApi.getSystemMemory.mockResolvedValue({
      totalBytes: 16 * GB,
      availableBytes: 5 * GB,
      pressure: "normal",
    });
    mockInstanceSettingsApi.getRunAdmissionRecommendation.mockResolvedValue(NO_USAGE_RECOMMENDATION);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    queryClient.clear();
    container.remove();
    vi.clearAllMocks();
  });

  async function renderPage(health: Record<string, unknown> = SELF_HOSTED_HEALTH) {
    mockHealthApi.get.mockResolvedValue(health);
    queryClient.setQueryData(queryKeys.health, health);
    root = createRoot(container);
    flushSync(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <InstanceGeneralSettings />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Run limits"));
  }

  function inputLabelled(label: string) {
    const labelEl = Array.from(container.querySelectorAll("label"))
      .find((el) => el.textContent === label);
    return container.querySelector<HTMLInputElement>(`#${CSS.escape(labelEl?.getAttribute("for") ?? "")}`)!;
  }

  function typeInto(input: HTMLInputElement, value: string) {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    flushSync(() => {
      setValue.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function buttonNamed(name: string) {
    return Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === name);
  }

  it("shows the saved values, machine memory, and the suggested cap", async () => {
    await renderPage();

    expect(inputLabelled("Run cap").value).toBe("4");
    expect(inputLabelled("RAM floor (MB)").value).toBe("3072");
    await vi.waitFor(() => expect(container.textContent).toContain("Total RAM 16 GB"));
    expect(container.textContent).toContain("Available now 5 GB");
    // (16384 - 3072) / 500 = 26.6
    expect(container.textContent).toContain(
      "16 GB machine minus 3 GB floor, about 500 MB per run: suggested 26 runs",
    );
  });

  it("sends both fields when only the cap changes", async () => {
    await renderPage();
    const save = buttonNamed("Save run limits")!;
    expect(save.disabled).toBe(true);

    typeInto(inputLabelled("Run cap"), "8");
    expect(save.disabled).toBe(false);
    flushSync(() => save.click());

    await vi.waitFor(() => expect(mockInstanceSettingsApi.updateGeneral).toHaveBeenCalledOnce());
    expect(mockInstanceSettingsApi.updateGeneral.mock.calls[0]?.[0]).toEqual({
      runAdmission: { maxConcurrentRuns: 8, minAvailableMemoryMb: 3072 },
    });
  });

  it("sends both fields when only the RAM floor changes", async () => {
    await renderPage();

    typeInto(inputLabelled("RAM floor (MB)"), "0");
    flushSync(() => buttonNamed("Save run limits")!.click());

    await vi.waitFor(() => expect(mockInstanceSettingsApi.updateGeneral).toHaveBeenCalledOnce());
    expect(mockInstanceSettingsApi.updateGeneral.mock.calls[0]?.[0]).toEqual({
      runAdmission: { maxConcurrentRuns: 4, minAvailableMemoryMb: 0 },
    });
  });

  it("uses the defaults when nothing is stored and fills in the suggestion", async () => {
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({
      censorUsernameInLogs: false,
      keyboardShortcuts: false,
      feedbackDataSharingPreference: "not_allowed",
      backupRetention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
    });
    await renderPage();
    expect(inputLabelled("Run cap").value).toBe("6");
    expect(inputLabelled("RAM floor (MB)").value).toBe("2048");

    await vi.waitFor(() => expect(buttonNamed("Use suggested")).toBeDefined());
    flushSync(() => buttonNamed("Use suggested")!.click());
    expect(inputLabelled("Run cap").value).toBe("28");
  });

  it("blocks saving an out-of-range cap", async () => {
    await renderPage();

    typeInto(inputLabelled("Run cap"), "0");

    expect(container.textContent).toContain("Enter a whole number from 1 to 1000.");
    expect(buttonNamed("Save run limits")!.disabled).toBe(true);
  });

  it("still lets the limits be edited when machine memory cannot be read", async () => {
    mockInstanceSettingsApi.getSystemMemory.mockRejectedValue(new Error("nope"));
    await renderPage();

    await vi.waitFor(() =>
      expect(container.textContent).toContain("Machine memory is not available, so no cap is suggested."),
    );
    typeInto(inputLabelled("Run cap"), "3");
    expect(buttonNamed("Save run limits")!.disabled).toBe(false);
  });

  it("hides the section when the operator hides run limits", async () => {
    mockHealthApi.get.mockResolvedValue({
      ...SELF_HOSTED_HEALTH,
      hiddenSettings: ["instance.general.runAdmission"],
    });
    queryClient.setQueryData(queryKeys.health, {
      ...SELF_HOSTED_HEALTH,
      hiddenSettings: ["instance.general.runAdmission"],
    });
    root = createRoot(container);
    flushSync(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <InstanceGeneralSettings />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Backup retention"));
    expect(container.textContent).not.toContain("Run limits");
  });
});

describe("InstanceGeneralSettings usage recommendation (GRE-117)", () => {
  const GB = 1024 * 1024 * 1024;
  let container: HTMLDivElement;
  let root: Root | null;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({
      censorUsernameInLogs: false,
      keyboardShortcuts: false,
      feedbackDataSharingPreference: "not_allowed",
      backupRetention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
      runAdmission: { maxConcurrentRuns: 4, minAvailableMemoryMb: 3072 },
    });
    mockInstanceSettingsApi.updateGeneral.mockResolvedValue(undefined);
    mockInstanceSettingsApi.getSystemMemory.mockResolvedValue({
      totalBytes: 16 * GB,
      availableBytes: 5 * GB,
      pressure: "normal",
    });
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    queryClient.clear();
    container.remove();
    vi.clearAllMocks();
  });

  async function renderPage() {
    mockHealthApi.get.mockResolvedValue(SELF_HOSTED_HEALTH);
    queryClient.setQueryData(queryKeys.health, SELF_HOSTED_HEALTH);
    root = createRoot(container);
    flushSync(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <InstanceGeneralSettings />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Run limits"));
  }

  function box() {
    return container.querySelector<HTMLElement>('[data-testid="run-admission-recommendation"]');
  }

  function applyButton() {
    return Array.from(box()?.querySelectorAll("button") ?? [])
      .find((button) => button.textContent?.trim() === "Apply");
  }

  it("shows suggested vs current and the reasons, and saves only on Apply", async () => {
    mockInstanceSettingsApi.getRunAdmissionRecommendation.mockResolvedValue(USAGE_RECOMMENDATION);
    await renderPage();

    await vi.waitFor(() => expect(box()).not.toBeNull());
    const text = box()!.textContent ?? "";
    expect(text).toContain("Recommended from your usage");
    const capRow = Array.from(box()!.querySelectorAll("tbody tr"))
      .find((row) => row.querySelector("th")?.textContent === "Run cap");
    expect(Array.from(capRow!.querySelectorAll("td")).map((cell) => cell.textContent)).toEqual(["4", "5"]);
    expect(text).toContain("raise the cap by one to 5.");
    expect(mockInstanceSettingsApi.updateGeneral).not.toHaveBeenCalled();

    flushSync(() => applyButton()!.click());

    await vi.waitFor(() => expect(mockInstanceSettingsApi.updateGeneral).toHaveBeenCalledOnce());
    expect(mockInstanceSettingsApi.updateGeneral.mock.calls[0]?.[0]).toEqual({
      runAdmission: { maxConcurrentRuns: 5, minAvailableMemoryMb: 3072 },
    });
    const capLabel = Array.from(container.querySelectorAll("label"))
      .find((el) => el.textContent === "Run cap");
    expect(container.querySelector<HTMLInputElement>(`#${CSS.escape(capLabel!.getAttribute("for")!)}`)!.value)
      .toBe("5");
  });

  it("shows only the RAM-based suggestion when there is no usage data yet", async () => {
    mockInstanceSettingsApi.getRunAdmissionRecommendation.mockResolvedValue(NO_USAGE_RECOMMENDATION);
    await renderPage();

    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        "16 GB machine minus 3 GB floor, about 500 MB per run: suggested 26 runs",
      ),
    );
    await vi.waitFor(() =>
      expect(mockInstanceSettingsApi.getRunAdmissionRecommendation).toHaveBeenCalled(),
    );
    expect(box()).toBeNull();
    expect(container.textContent).not.toContain("Recommended from your usage");
  });

  it("falls back to the RAM-based suggestion when the recommendation cannot load", async () => {
    mockInstanceSettingsApi.getRunAdmissionRecommendation.mockRejectedValue(new Error("nope"));
    await renderPage();

    await vi.waitFor(() => expect(container.textContent).toContain("suggested 26 runs"));
    expect(box()).toBeNull();
  });
});
