// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const health = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/api/health", () => ({ healthApi: health }));
vi.mock("@/api/auth", () => ({ authApi: { getSession: vi.fn() } }));
vi.mock("@/api/access", () => ({ accessApi: { getCurrentBoardAccess: vi.fn(), claimBootstrapAdmin: vi.fn() } }));
vi.mock("@/lib/router", () => ({
  Outlet: () => <p>APP</p>,
  Navigate: () => null,
  useLocation: () => ({ pathname: "/GRE/inbox", search: "" }),
}));
vi.mock("@/components/BrandLoading", () => ({ BrandLoading: () => <p>LOADING</p> }));
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
