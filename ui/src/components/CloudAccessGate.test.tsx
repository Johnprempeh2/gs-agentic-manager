// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const health = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/api/health", () => ({ healthApi: health }));
const auth = vi.hoisted(() => ({ getSession: vi.fn(), getTwoStepStatus: vi.fn() }));
const access = vi.hoisted(() => ({ getCurrentBoardAccess: vi.fn(), claimBootstrapAdmin: vi.fn() }));
vi.mock("@/api/auth", () => ({ authApi: auth }));
vi.mock("@/api/access", () => ({ accessApi: access }));
vi.mock("@/components/TwoStepSignInSection", () => ({ TwoStepSignInSection: () => <p>SETUP</p> }));
vi.mock("@/hooks/useSignOut", () => ({ useSignOut: () => ({ mutate: vi.fn(), isPending: false }) }));
const location = vi.hoisted(() => ({ pathname: "/GRE/inbox", search: "" }));
vi.mock("@/lib/router", () => ({
  Outlet: () => <p>APP</p>,
  Navigate: () => null,
  useLocation: () => location,
}));
vi.mock("@/components/AppShellSkeleton", () => ({ AppShellSkeleton: () => <p>LOADING</p> }));
vi.mock("@/components/BootstrapPendingPage", () => ({ BootstrapPendingPage: () => null }));

const { CloudAccessGate } = await import("./CloudAccessGate");
const { queryKeys } = await import("@/lib/queryKeys");

const localHealth = { status: "ok", deploymentMode: "local_trusted" };

describe("CloudAccessGate when the server stops answering", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    health.get.mockReset();
    client = new QueryClient();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  // React Query tells components about a refetch on a later tick.
  async function refetchHealth() {
    await act(async () => {
      await client.refetchQueries({ queryKey: queryKeys.health });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  async function render() {
    await act(async () => root.render(
      <QueryClientProvider client={client}><CloudAccessGate /></QueryClientProvider>,
    ));
  }

  it("keeps the app on screen when a later check cannot reach the server", async () => {
    health.get.mockResolvedValueOnce(localHealth);
    await render();
    await vi.waitFor(() => expect(container.textContent).toBe("APP"));

    health.get.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await refetchHealth();
    expect(container.textContent).toBe("APP");
  });

  it("explains in plain words when nothing could load, with a way to try again", async () => {
    health.get.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("GSAM is not answering"));
    expect(container.textContent).not.toContain("Failed to fetch");

    health.get.mockResolvedValueOnce(localHealth);
    const retry = [...container.querySelectorAll("button")].find((b) => b.textContent === "Try again")!;
    await act(async () => retry.click());
    await vi.waitFor(() => expect(container.textContent).toBe("APP"));
  });

  it("still stops on a server error", async () => {
    health.get.mockResolvedValueOnce(localHealth);
    await render();
    await vi.waitFor(() => expect(container.textContent).toBe("APP"));

    health.get.mockRejectedValueOnce(new Error("Failed to load health (500)"));
    await refetchHealth();
    expect(container.textContent).toContain("Failed to load health (500)");
  });
});

describe("CloudAccessGate when two-step sign-in is required", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    health.get.mockReset().mockResolvedValue({ status: "ok", deploymentMode: "authenticated", bootstrapStatus: "ready" });
    auth.getSession.mockReset().mockResolvedValue({ session: { id: "s1", userId: "u1" }, user: { id: "u1" } });
    access.getCurrentBoardAccess.mockReset().mockResolvedValue({ isInstanceAdmin: false, companyIds: ["c1"] });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    await act(async () => root.render(
      <QueryClientProvider client={new QueryClient()}><CloudAccessGate /></QueryClientProvider>,
    ));
  }

  it("holds a person without it at setup, and asks the server for nothing else", async () => {
    auth.getTwoStepStatus.mockResolvedValue({ enabled: false, available: true, required: true });
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("Turn on two-step sign-in to continue"));
    expect(container.textContent).toContain("SETUP");
    expect(access.getCurrentBoardAccess).not.toHaveBeenCalled();
  });

  it("lets a person with it on through", async () => {
    auth.getTwoStepStatus.mockResolvedValue({ enabled: true, available: true, required: true });
    await render();
    await vi.waitFor(() => expect(container.textContent).toBe("APP"));
  });

  it("does not block when the status cannot be read", async () => {
    auth.getTwoStepStatus.mockRejectedValue(new Error("Not found"));
    await render();
    await vi.waitFor(() => expect(container.textContent).toBe("APP"));
  });
});

describe("CloudAccessGate on a GSAM for Mac install that is held", () => {
  let container: HTMLDivElement;
  let root: Root;
  const service = (state: string) => ({ state, renewUrl: "https://renew.test", validUntil: "2026-11-01T23:59:59Z" });

  beforeEach(() => {
    location.pathname = "/GRE/inbox";
    auth.getSession.mockReset().mockResolvedValue({ session: { id: "s1", userId: "u1" }, user: { id: "u1" } });
    auth.getTwoStepStatus.mockReset().mockResolvedValue({ enabled: false, available: false, required: false });
    access.getCurrentBoardAccess.mockReset().mockResolvedValue({ isInstanceAdmin: true, companyIds: ["c1"] });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(state: string) {
    health.get.mockReset().mockResolvedValue({ status: "ok", deploymentMode: "authenticated", bootstrapStatus: "ready", service: service(state) });
    await act(async () => root.render(
      <QueryClientProvider client={new QueryClient()}><CloudAccessGate /></QueryClientProvider>,
    ));
  }

  it("replaces the app with a full page when Greatstone stopped the service, with export and contact links", async () => {
    await render("stopped");
    await vi.waitFor(() => expect(container.textContent).toContain("Service stopped by Greatstone"));
    expect(container.textContent).not.toContain("APP");
    expect(container.textContent).toContain("Nothing has been deleted");
    const links = [...container.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);
    expect(links).toEqual([["Contact Greatstone", "https://renew.test"], ["Export your data", "/company/export"]]);
  });

  it("says the subscription ended, with a renew link", async () => {
    await render("ended");
    await vi.waitFor(() => expect(container.textContent).toContain("Your GSAM subscription has ended"));
    expect(container.textContent).toContain("1 November 2026");
    expect(container.querySelector("a")!.textContent).toBe("Renew your subscription");
  });

  it("keeps the export page open while stopped, with a banner", async () => {
    location.pathname = "/GRE/company/export";
    await render("stopped");
    await vi.waitFor(() => expect(container.textContent).toContain("APP"));
    expect(container.querySelector('[data-testid="service-hold-banner"]')!.textContent).toContain("export your data");
  });

  it("shows a banner over a working app when paused", async () => {
    await render("paused");
    await vi.waitFor(() => expect(container.textContent).toContain("APP"));
    expect(container.textContent).toContain("Paused by Greatstone");
  });

  it("shows nothing extra when the service is active", async () => {
    await render("active");
    await vi.waitFor(() => expect(container.textContent).toBe("APP"));
  });
});
