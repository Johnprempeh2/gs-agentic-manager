// @vitest-environment jsdom

import { act as reactAct, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentHoursCard } from "./DashboardCostCard";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  if (typeof reactAct === "function") {
    reactAct(callback);
    return;
  }
  flushSync(callback);
}

describe("AgentHoursCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows what the agents' hours cost at the company rate", () => {
    act(() =>
      root.render(
        <AgentHoursCard agentWorkMs={2 * 60 * 60 * 1000} minimumWageHourlyCents={1_250} minimumWageEquivalentCents={2_500} />,
      ),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("$25.00");
    expect(text).toContain("Agent hours at minimum wage this month");
    expect(text).toContain("2.0 h of agent work at $12.50 an hour.");
  });

  it("shows the hours and points to settings when no rate is set", () => {
    act(() =>
      root.render(
        <AgentHoursCard agentWorkMs={90 * 60 * 1000} minimumWageHourlyCents={null} minimumWageEquivalentCents={null} />,
      ),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("1.5 h");
    expect(text).toContain("Agent hours this month");
    expect(text).toContain("Set an hourly wage in Settings");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/company/settings");
  });
});
