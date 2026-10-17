// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const update = vi.fn(async () => ({}));
vi.mock("../api/agents", () => ({ agentsApi: { update: (...args: unknown[]) => update(...(args as [])) } }));
vi.mock("@/context/ConfirmContext", () => ({ useConfirm: () => async () => true }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));

import { EmptyTimerRunsBanner } from "./EmptyTimerRunsBanner";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
afterEach(() => {
  container?.remove();
  container = null;
  update.mockClear();
  window.localStorage.clear();
});

const agents = [
  { id: "a1", name: "Everest", status: "idle", runtimeConfig: { heartbeat: { enabled: true, intervalSec: 300 } } },
  { id: "a2", name: "Mason", status: "idle", runtimeConfig: { heartbeat: { enabled: true, skipTimerWhenNothingChanged: true } } },
] as never[];

function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <EmptyTimerRunsBanner companyId="c1" agents={agents} />
      </QueryClientProvider>,
    ),
  );
  return container;
}

describe("EmptyTimerRunsBanner", () => {
  it("names the agents and turns the skip on for them only", async () => {
    const root = render();
    expect(root.textContent).toContain("1 agent wakes on a timer even when nothing has changed");
    expect(root.textContent).toContain("Everest");
    const button = [...root.querySelectorAll("button")].find((b) => b.textContent === "Skip empty runs")!;
    await act(async () => {
      button.click();
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      "a1",
      { runtimeConfig: { heartbeat: { enabled: true, intervalSec: 300, skipTimerWhenNothingChanged: true } } },
      "c1",
    );
  });

  it("hides after Not now", () => {
    const root = render();
    const button = [...root.querySelectorAll("button")].find((b) => b.textContent === "Not now")!;
    act(() => button.click());
    expect(root.textContent).toBe("");
  });
});
