// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const health = vi.hoisted(() => ({ get: vi.fn() }));
const toast = vi.hoisted(() => ({ pushToast: vi.fn() }));
vi.mock("@/api/health", () => ({ healthApi: health }));
vi.mock("@/context/ToastContext", () => ({ useOptionalToastActions: () => toast }));

const { ConnectionNotice, isNetworkFailure } = await import("./ConnectionNotice");

const server = { up: true };

function Inbox() {
  const { data } = useQuery({
    queryKey: ["inbox"],
    queryFn: async () => {
      if (!server.up) throw new TypeError("Failed to fetch");
      return "three tasks";
    },
    retry: false,
  });
  return <p data-testid="inbox">{data ?? "loading"}</p>;
}

describe("ConnectionNotice", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    server.up = true;
    health.get.mockReset();
    toast.pushToast.mockReset();
    client = new QueryClient();
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
      <QueryClientProvider client={client}>
        <ConnectionNotice />
        <Inbox />
      </QueryClientProvider>,
    ));
  }

  const notice = () => container.querySelector('[data-testid="connection-notice"]');

  it("treats only fetches that never reached the server as lost connection", () => {
    expect(isNetworkFailure(new TypeError("Failed to fetch"))).toBe(true);
    expect(isNetworkFailure(new Error("Request failed (500)"))).toBe(false);
  });

  it("keeps the list on screen, says how old it is, and recovers on Try again", async () => {
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("three tasks"));
    expect(notice()).toBeNull();

    server.up = false;
    await act(async () => { await client.refetchQueries({ queryKey: ["inbox"] }); });
    await vi.waitFor(() => expect(notice()?.textContent).toContain("GSAM is not answering."));
    expect(notice()?.textContent).toContain("Showing what was loaded just now.");
    expect(container.querySelector('[data-testid="inbox"]')?.textContent).toBe("three tasks");

    health.get.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const tryAgain = () => [...container.querySelectorAll("button")].find((b) => b.textContent === "Try again")!;
    await act(async () => tryAgain().click());
    expect(notice()?.textContent).toContain("Still no connection.");

    server.up = true;
    health.get.mockResolvedValueOnce({ status: "ok" });
    await act(async () => tryAgain().click());
    await vi.waitFor(() => expect(notice()).toBeNull());
    expect(toast.pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Back online" }));
  });

  it("says the device is offline when the browser reports it", async () => {
    await render();
    await act(async () => { window.dispatchEvent(new Event("offline")); });
    expect(notice()?.textContent).toContain("You are offline.");
    await act(async () => { window.dispatchEvent(new Event("online")); });
    expect(notice()).toBeNull();
  });
});
