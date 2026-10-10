// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrategyBoardExperimentalGate } from "./StrategyBoardExperimentalGate";

const api = vi.hoisted(() => ({ settings: vi.fn() }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: api.settings } }));
vi.mock("@/lib/router", () => ({ Navigate: ({ to }: { to: string }) => <div data-redirect={to} /> }));

async function flushReact() {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => {});
}

describe("StrategyBoardExperimentalGate (GRE-1135)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(() => {
    flushSync(() => root.unmount());
    client.clear();
    container.remove();
    vi.clearAllMocks();
  });
  async function render() {
    flushSync(() =>
      root.render(
        <QueryClientProvider client={client}>
          <StrategyBoardExperimentalGate>
            <div data-board>Board</div>
          </StrategyBoardExperimentalGate>
        </QueryClientProvider>,
      ),
    );
    await flushReact();
  }

  it("redirects to Goals and shows nothing of the board while the switch is off", async () => {
    api.settings.mockResolvedValue({ enableStrategyBoard: false });
    await render();
    expect(container.querySelector("[data-board]")).toBeNull();
    expect(container.querySelector("[data-redirect]")?.getAttribute("data-redirect")).toBe("/goals");
  });

  it("shows the board while the switch is on", async () => {
    api.settings.mockResolvedValue({ enableStrategyBoard: true });
    await render();
    expect(container.querySelector("[data-board]")?.textContent).toBe("Board");
  });
});
