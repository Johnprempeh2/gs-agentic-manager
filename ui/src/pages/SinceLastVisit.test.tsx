// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentWorkDigest } from "@greatstone/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SinceLastVisit } from "./SinceLastVisit";

const mockDigestApi = vi.hoisted(() => ({ get: vi.fn(), recordVisit: vi.fn() }));
vi.mock("../api/agentWorkDigest", () => ({ agentWorkDigestApi: mockDigestApi }));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: React.ComponentProps<"a"> & { to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", companies: [] }),
}));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const at = new Date().toISOString();
const digest: AgentWorkDigest = {
  companyId: "company-1",
  since: new Date(Date.now() - 9 * 60 * 60 * 1000).toISOString(),
  sinceSource: "last_visit",
  generatedAt: at,
  counts: { tasksFinished: 1, tasksStarted: 1, decisionsRaised: 1, failures: 0 },
  agents: [
    {
      agentId: "ridge",
      agentName: "Ridge",
      counts: { tasksFinished: 1, tasksStarted: 0, decisionsRaised: 1, failures: 0 },
      items: [
        { kind: "decision_raised", label: "Asked you to approve GRE-9: Deploy", at, issueId: "i9", issueIdentifier: "GRE-9", runId: null },
        { kind: "task_finished", label: "Finished GRE-8: Fix login copy", at, issueId: "i8", issueIdentifier: "GRE-8", runId: null },
      ],
    },
    {
      agentId: "mica",
      agentName: "Mica",
      counts: { tasksFinished: 0, tasksStarted: 1, decisionsRaised: 0, failures: 0 },
      items: [{ kind: "task_started", label: "Started GRE-7: Phone tab bar", at, issueId: "i7", issueIdentifier: null, runId: null }],
    },
  ],
};

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("SinceLastVisit", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockDigestApi.recordVisit.mockResolvedValue({ companyId: "company-1", lastVisitedAt: at });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function render() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SinceLastVisit />
        </QueryClientProvider>,
      );
    });
  }

  it("groups the digest by agent, links each line to its task, and records the visit once", async () => {
    mockDigestApi.get.mockResolvedValue(digest);
    render();
    await flush();

    expect(container.querySelector("h1")?.textContent).toBe("Since you were last here");
    expect(container.textContent).toContain("Since your last visit, 9h ago");
    expect(Array.from(container.querySelectorAll("h2")).map((h) => h.textContent)).toEqual(["Ridge", "Mica"]);

    const hrefs = Array.from(container.querySelectorAll("section a")).map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/issues/GRE-9", "/issues/GRE-8", "/issues/i7"]);

    expect(mockDigestApi.recordVisit).toHaveBeenCalledTimes(1);
    expect(mockDigestApi.recordVisit).toHaveBeenCalledWith("company-1");
    // Recording the visit must not refetch and empty the page being read.
    expect(mockDigestApi.get).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Ridge");
  });

  it("says when nothing happened and still offers the full Audit log", async () => {
    mockDigestApi.get.mockResolvedValue({ ...digest, agents: [], counts: { tasksFinished: 0, tasksStarted: 0, decisionsRaised: 0, failures: 0 } });
    render();
    await flush();

    expect(container.textContent).toContain("No new agent work since your last visit.");
    expect(container.querySelector('a[href="/activity"]')).not.toBeNull();
  });

  it("does not record a visit when the digest fails to load", async () => {
    mockDigestApi.get.mockRejectedValue(new Error("offline"));
    render();
    await flush();

    expect(mockDigestApi.recordVisit).not.toHaveBeenCalled();
  });
});
