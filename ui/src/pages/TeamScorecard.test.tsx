// @vitest-environment jsdom

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamScorecard as TeamScorecardData } from "@greatstone/shared";
import { STUCK_TASK_UPDATE_REQUEST } from "../lib/team-scorecard";
import { TeamScorecard } from "./TeamScorecard";

const api = vi.hoisted(() => ({ scorecard: vi.fn(), apiEquivalent: vi.fn(), addComment: vi.fn() }));

vi.mock("../api/teamScorecard", () => ({ teamScorecardApi: { get: api.scorecard } }));
vi.mock("../api/costs", () => ({ costsApi: { apiEquivalent: api.apiEquivalent } }));
vi.mock("../api/issues", () => ({ issuesApi: { addComment: api.addComment } }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "c1", selectedCompany: { id: "c1", name: "Acme", issuePrefix: "ACM" } }),
}));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));

const scorecard: TeamScorecardData = {
  since: "2026-10-09T00:00:00.000Z",
  days: 7,
  totals: { finished: 1, underWay: 0, inReview: 0, stuck: 1, overdue: 0 },
  agents: [
    {
      agentId: "a1",
      name: "Ridge",
      title: "Engineer",
      status: "idle",
      finished: 1,
      underWay: 0,
      inReview: 0,
      stuck: 1,
      overdue: 0,
      recentlyFinished: [{ id: "t1", identifier: "ACM-1", title: "Booking page" }],
      stuckTasks: [{ id: "t2", identifier: "ACM-2", title: "Pipedrive import" }],
    },
  ],
};

async function flushReact() {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => {});
}

describe("TeamScorecard", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    api.scorecard.mockResolvedValue(scorecard);
    api.apiEquivalent.mockResolvedValue({ byAgent: [] });
    api.addComment.mockResolvedValue({ id: "comment-1" });
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
          <MemoryRouter>
            <TeamScorecard />
          </MemoryRouter>
        </QueryClientProvider>,
      ),
    );
    await flushReact();
  }

  it("compares what was finished with the week before", async () => {
    api.scorecard.mockImplementation(async (_companyId: string, days: number) =>
      days === 14 ? { ...scorecard, days: 14, totals: { ...scorecard.totals, finished: 4 } } : scorecard,
    );
    await render();
    expect(api.scorecard).toHaveBeenCalledWith("c1", 14);
    expect(container.textContent).toContain("Down from 3 the week before");
    // Ridge finished 1 this week; the 14 day scorecard has no extra rows for Ridge, so 0 the week before.
    expect(container.textContent).toContain("Finished tasks: up from 0 the week before.");
  });

  it("asks the agent on a stuck task for an update", async () => {
    await render();
    const buttons = Array.from(container.querySelectorAll("button")).filter((button) =>
      button.textContent?.includes("Ask for an update"),
    );
    // Only stuck tasks offer it, not finished ones.
    expect(buttons).toHaveLength(1);

    await act(async () => {
      buttons[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(api.addComment).toHaveBeenCalledWith("t2", STUCK_TASK_UPDATE_REQUEST, undefined, undefined, undefined, expect.any(String));
    expect(container.textContent).toContain("Asked");
  });

  it("asks about every stuck task at once, then hides the button", async () => {
    api.scorecard.mockResolvedValue({
      ...scorecard,
      agents: [
        { ...scorecard.agents[0]!, stuckTasks: [{ id: "t2", identifier: "ACM-2", title: "Pipedrive import" }] },
        {
          ...scorecard.agents[0]!,
          agentId: "a2",
          name: "Lodestone",
          stuckTasks: [{ id: "t3", identifier: "ACM-3", title: "Board pack" }],
        },
      ],
    });
    await render();
    const askAll = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Ask about all 2 stuck tasks"),
    );
    expect(askAll).toBeDefined();

    await act(async () => {
      askAll!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(api.addComment).toHaveBeenCalledTimes(2);
    expect(api.addComment.mock.calls.map((call) => call[0]).sort()).toEqual(["t2", "t3"]);
    expect(container.textContent?.match(/Asked/g)).toHaveLength(2);
    expect(container.textContent).not.toContain("Ask about all");
  });
});
