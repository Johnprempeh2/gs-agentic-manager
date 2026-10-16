// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue } from "@greatstone/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssuePropertiesPlansTab } from "./IssuePropertiesPlansTab";

// GRE-1090: the server refuses the decompositions read while the switch is
// off, so the tab must not request it.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockGetExperimental = vi.hoisted(() => vi.fn());
const mockListAcceptedPlanDecompositions = vi.hoisted(() => vi.fn(async () => []));

vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: mockGetExperimental } }));
vi.mock("@/api/issues", () => ({
  issuesApi: {
    listAcceptedPlanDecompositions: mockListAcceptedPlanDecompositions,
    listInteractions: async () => [],
  },
}));
vi.mock("@/hooks/useIssuePlanDocument", () => ({ useIssuePlanDocument: () => ({ data: null, isLoading: false }) }));
vi.mock("@/lib/router", () => ({ useLocation: () => ({ hash: "" }) }));
vi.mock("@/components/IssuePlanDecompositionsSection", () => ({ IssuePlanDecompositionsSection: () => null }));

const issue = { id: "issue-1", identifier: "GRE-1", workMode: "standard" } as Issue;

describe("IssuePropertiesPlansTab", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockGetExperimental.mockReset();
    mockListAcceptedPlanDecompositions.mockClear();
  });

  afterEach(() => {
    container.remove();
  });

  async function renderTab() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <IssuePropertiesPlansTab issue={issue} />
        </QueryClientProvider>,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return root;
  }

  it("does not request plan decompositions while the switch is off", async () => {
    mockGetExperimental.mockResolvedValue({ enableIssuePlanDecompositions: false });
    const root = await renderTab();
    expect(mockGetExperimental).toHaveBeenCalled();
    expect(mockListAcceptedPlanDecompositions).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("requests plan decompositions once the switch is on", async () => {
    mockGetExperimental.mockResolvedValue({ enableIssuePlanDecompositions: true });
    const root = await renderTab();
    expect(mockListAcceptedPlanDecompositions).toHaveBeenCalledWith("issue-1");
    await act(async () => root.unmount());
  });
});
