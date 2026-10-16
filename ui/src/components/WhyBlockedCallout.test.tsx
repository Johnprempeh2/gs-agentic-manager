// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WhyBlockedInput } from "../lib/why-blocked";

const mockActivityApi = vi.hoisted(() => ({ runsForIssue: vi.fn() }));
const mockIssuesApi = vi.hoisted(() => ({ listApprovals: vi.fn() }));

vi.mock("../api/activity", () => ({ activityApi: mockActivityApi }));
vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("../lib/router", () => ({
  Link: ({ children, to, ...props }: React.ComponentProps<"a"> & { to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

import { WhyBlockedCallout } from "./WhyBlockedCallout";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agents = new Map([["agent-grace", { name: "Grace", status: "active" }]]);

function baseIssue(overrides: Partial<WhyBlockedInput["issue"]> = {}): WhyBlockedInput["issue"] {
  return {
    id: "issue-1",
    identifier: "GRE-1",
    status: "blocked",
    assigneeAgentId: null,
    assigneeUserId: null,
    ...overrides,
  };
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("WhyBlockedCallout", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockActivityApi.runsForIssue.mockResolvedValue([]);
    mockIssuesApi.listApprovals.mockResolvedValue([]);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function render(props: Omit<React.ComponentProps<typeof WhyBlockedCallout>, "currentUserId" | "agents">) {
    flushSync(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <WhyBlockedCallout currentUserId="user-john" agents={agents} {...props} />
        </QueryClientProvider>,
      ),
    );
  }

  it("says who the task waits on and links to the blocking task", async () => {
    render({
      issue: baseIssue({
        blockedBy: [
          {
            id: "issue-12",
            identifier: "GRE-12",
            title: "Calibrate lidar",
            status: "in_progress",
            priority: "medium",
            assigneeAgentId: "agent-grace",
            assigneeUserId: null,
          },
        ],
      }),
    });
    await settle();
    const callout = container.querySelector('[data-testid="why-blocked-callout"]');
    expect(callout).not.toBeNull();
    expect(callout?.getAttribute("role")).toBe("status");
    expect(container.querySelector('[data-testid="why-blocked-headline"]')?.textContent).toBe(
      "Waiting on Grace to finish 'Calibrate lidar' (GRE-12).",
    );
    expect(container.querySelector('[data-testid="why-blocked-next"]')?.textContent).toBe(
      "Who can clear it: Grace. Nothing to do now. This task starts again when GRE-12 is done.",
    );
    const link = container.querySelector('[data-testid="why-blocked-link"]');
    expect(link?.textContent).toBe("Open GRE-12");
    expect(link?.getAttribute("href")).toBe("/issues/GRE-12");
  });

  it("points to the questions waiting for the reader", async () => {
    render({
      issue: baseIssue(),
      interactions: [
        {
          id: "int-1",
          kind: "ask_user_questions",
          status: "pending",
          addresseeAgentId: null,
          addresseeUserId: null,
          payload: { questions: [{ id: "a" }, { id: "b" }] },
        },
      ],
    });
    await settle();
    expect(container.querySelector('[data-testid="why-blocked-headline"]')?.textContent).toBe(
      "Waiting for you to answer 2 questions.",
    );
    expect(container.querySelector('[data-testid="why-blocked-link"]')?.getAttribute("href")).toBe("#interaction-int-1");
  });

  it("uses a pending approval linked to the task", async () => {
    mockIssuesApi.listApprovals.mockResolvedValue([{ id: "appr-1", status: "pending" }]);
    render({ issue: baseIssue() });
    await settle();
    expect(container.querySelector('[data-testid="why-blocked-headline"]')?.textContent).toBe(
      "Waiting for you to approve a request.",
    );
    expect(container.querySelector('[data-testid="why-blocked-link"]')?.getAttribute("href")).toBe("/approvals/appr-1");
  });

  it("falls back to a plain sentence with no link", async () => {
    render({ issue: baseIssue() });
    await settle();
    expect(container.querySelector('[data-testid="why-blocked-headline"]')?.textContent).toBe(
      "Marked blocked, but nobody has said why.",
    );
    expect(container.querySelector('[data-testid="why-blocked-link"]')).toBeNull();
  });

  it("renders nothing and fetches nothing when the task is not blocked", async () => {
    render({ issue: baseIssue({ status: "in_progress" }) });
    await settle();
    expect(container.querySelector('[data-testid="why-blocked-callout"]')).toBeNull();
    expect(mockActivityApi.runsForIssue).not.toHaveBeenCalled();
    expect(mockIssuesApi.listApprovals).not.toHaveBeenCalled();
  });
});
