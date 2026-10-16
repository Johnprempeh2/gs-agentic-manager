// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, IssueBlockedInboxAttention } from "@greatstone/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockIssuesApi = vi.hoisted(() => ({
  list: vi.fn(),
  count: vi.fn(),
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    className,
    disableIssueQuicklook: _disableIssueQuicklook,
    issuePrefetch: _issuePrefetch,
    ...props
  }: React.ComponentProps<"a"> & { disableIssueQuicklook?: boolean; issuePrefetch?: Issue | null }) => (
    <a className={className} {...props}>
      {children}
    </a>
  ),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> | undefined;
  flushSync(() => {
    result = callback();
  });
  return result;
}

import { BlockedInboxView } from "./BlockedInboxView";
import { defaultIssueFilterState } from "../lib/issue-filters";

function attention(
  overrides: Partial<IssueBlockedInboxAttention> = {},
): IssueBlockedInboxAttention {
  return {
    kind: "blocked",
    state: "needs_attention",
    reason: "blocked_chain_stalled",
    severity: "medium",
    stoppedSinceAt: "2026-05-08T10:00:00.000Z",
    owner: { type: "agent", agentId: "agent-1", userId: null, label: null },
    action: { label: "Resolve PAP-77", detail: null },
    sourceIssue: null,
    leafIssue: null,
    recoveryIssue: null,
    approvalId: null,
    interactionId: null,
    sampleIssueIdentifier: null,
    redaction: { externalDetailsRedacted: false, secretFieldsOmitted: true },
    ...overrides,
  };
}

function makeIssue(
  id: string,
  identifier: string,
  title: string,
  attentionPayload: IssueBlockedInboxAttention,
): Issue {
  return {
    id,
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title,
    description: null,
    status: "in_progress",
    workMode: "standard",
    priority: "medium",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    identifier,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    blockedInboxAttention: attentionPayload,
    createdAt: new Date("2026-05-09T00:00:00.000Z"),
    updatedAt: new Date("2026-05-09T00:00:00.000Z"),
  } as Issue;
}

function renderWithClient(node: React.ReactNode, container: HTMLDivElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  const root = createRoot(container);
  act(() => {
    root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
  });
  return { root, queryClient };
}

const blockedViewProps = {
  companyId: "company-1",
  searchQuery: "",
  agentNameById: new Map<string, string>(),
  issueLinkState: null,
  groupBy: "none" as const,
  sortBy: "most_recent" as const,
  issueFilters: defaultIssueFilterState,
  currentUserId: "local-board",
  liveIssueIds: new Set<string>(),
  subtreeLiveCounts: new Map<string, number>(),
  workspaceFilterContext: {},
  showStatusColumn: true,
  showIdentifierColumn: true,
  showUpdatedColumn: true,
};

async function waitFor(predicate: () => boolean, attempts = 30): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error("waitFor predicate did not become true");
}

describe("BlockedInboxView", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockIssuesApi.list.mockReset();
  });

  afterEach(() => {
    container.remove();
  });

  it("shows the empty state when no blocked issues are returned", async () => {
    mockIssuesApi.list.mockResolvedValue([]);
    const { root } = renderWithClient(
      <BlockedInboxView
        {...blockedViewProps}
        presentation="task"
      />,
      container,
    );
    await waitFor(() => container.querySelector('[data-testid="blocked-inbox-empty"]') !== null);
    expect(container.querySelector('[data-testid="blocked-inbox-empty"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it("says on each row, in plain words, why the task is blocked and who can clear it", async () => {
    const issue = {
      ...makeIssue(
        "issue-wait",
        "PAP-4",
        "Calibrate rig",
        attention({ reason: "blocked_chain_stalled", severity: "high" }),
      ),
      status: "blocked",
      blockedBy: [
        {
          id: "issue-12",
          identifier: "PAP-12",
          title: "Order lidar",
          status: "in_progress",
          priority: "medium",
          assigneeAgentId: "agent-grace",
          assigneeUserId: null,
        },
      ],
    } as Issue;
    mockIssuesApi.list.mockResolvedValue([issue]);
    const { root } = renderWithClient(
      <BlockedInboxView
        {...blockedViewProps}
        agentNameById={new Map([["agent-grace", "Grace"]])}
        presentation="task"
      />,
      container,
    );
    await waitFor(() => container.querySelector('[data-slot="task-row-why-blocked"]') !== null);
    const note = container.querySelector('[data-slot="task-row-why-blocked"]');
    expect(note?.textContent).toBe("Waiting on Grace to finish 'Order lidar' (PAP-12). Who can clear it: Grace.");
    act(() => root.unmount());
  });

  it("defaults to no grouping and orders rows by most recent stopped item first", async () => {
    const issues: Issue[] = [
      makeIssue(
        "issue-low",
        "PAP-1",
        "External wait row",
        attention({ reason: "external_owner_action", severity: "low" }),
      ),
      makeIssue(
        "issue-stalled-high",
        "PAP-2",
        "Stalled chain row",
        attention({
          reason: "blocked_chain_stalled",
          severity: "high",
          stoppedSinceAt: "2026-05-09T01:00:00.000Z",
          action: { label: "Resolve PAP-9", detail: null },
        }),
      ),
      makeIssue(
        "issue-stalled-critical",
        "PAP-3",
        "Critical stalled row",
        attention({
          reason: "blocked_chain_stalled",
          severity: "critical",
          stoppedSinceAt: "2026-05-09T05:00:00.000Z",
          action: { label: "Resolve PAP-10", detail: null },
        }),
      ),
      makeIssue(
        "issue-decision",
        "PAP-4",
        "Pending board decision",
        attention({
          reason: "pending_board_decision",
          severity: "medium",
          owner: { type: "board", agentId: null, userId: null, label: "Board" },
          action: { label: "Accept or reject", detail: null },
        }),
      ),
    ];
    mockIssuesApi.list.mockResolvedValue(issues);

    const { root } = renderWithClient(
      <BlockedInboxView
        {...blockedViewProps}
        agentNameById={new Map([["agent-1", "ClaudeCoder"]])}
      />,
      container,
    );
    await waitFor(() => container.querySelectorAll("a").length === 4);

    expect(container.querySelectorAll('[data-testid^="blocked-inbox-group-"]')).toHaveLength(0);

    const titles = Array.from(container.querySelectorAll("a")).map((a) => a.textContent ?? "");
    expect(titles[0]).toContain("Critical stalled row");
    expect(titles[1]).toContain("Stalled chain row");

    expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", expect.objectContaining({
      attention: "blocked",
      includeBlockedInboxAttention: true,
      includeBlockedBy: true,
    }));

    act(() => root.unmount());
  });

  it("groups tasks by the root task they are all waiting on", async () => {
    const root1463 = {
      id: "leaf-1463",
      identifier: "GRE-1463",
      title: "Fix login",
      status: "in_progress" as const,
      priority: "medium" as const,
      assigneeAgentId: null,
      assigneeUserId: null,
    };
    mockIssuesApi.list.mockResolvedValue([
      makeIssue("issue-a", "PAP-1", "First waiting task", attention({ leafIssue: root1463 })),
      makeIssue("issue-b", "PAP-2", "Second waiting task", attention({ leafIssue: root1463 })),
      makeIssue("issue-c", "PAP-3", "Needs a decision", attention({ reason: "pending_board_decision" })),
    ]);

    const { root } = renderWithClient(
      <BlockedInboxView {...blockedViewProps} groupBy="root_blocker" />,
      container,
    );
    await waitFor(() => container.querySelectorAll("a").length === 3);

    const groups = Array.from(container.querySelectorAll('[data-testid^="blocked-inbox-group-"]'));
    expect(groups.map((g) => g.getAttribute("data-testid"))).toEqual([
      "blocked-inbox-group-root-leaf-1463",
      "blocked-inbox-group-root-none",
    ]);
    expect(groups[0]!.textContent).toContain("Waiting on GRE-1463 Fix login · 2");
    expect(groups[1]!.textContent).toContain("No single blocker · 1");

    act(() => root.unmount());
  });

  it("places blocker reason chips with the title before owner and timestamp metadata", async () => {
    mockIssuesApi.list.mockResolvedValue([
      makeIssue(
        "issue-decision",
        "PAP-4",
        "Pending board decision",
        attention({
          reason: "pending_board_decision",
          severity: "medium",
          owner: { type: "board", agentId: null, userId: null, label: "Board" },
          action: { label: "Accept or reject", detail: null },
        }),
      ),
    ]);

    const { root } = renderWithClient(
      <BlockedInboxView
        {...blockedViewProps}
        presentation="task"
      />,
      container,
    );
    await waitFor(() => container.querySelector("a") !== null);

    const rowText = container.querySelector("a")?.parentElement?.textContent ?? "";
    expect(rowText.indexOf("Pending board decision")).toBeGreaterThanOrEqual(0);
    expect(rowText.indexOf("Needs decision")).toBeGreaterThan(rowText.indexOf("Pending board decision"));
    expect(rowText.indexOf("Board")).toBeGreaterThan(rowText.indexOf("Needs decision"));
    expect(rowText).not.toContain("Accept or reject");
    expect(container.querySelector('[data-testid="blocked-row-reason-column"]')?.textContent).toContain("Needs decision");
    const taskRow = container.querySelector('[data-slot="task-row"]');
    const identifier = container.querySelector('[data-slot="task-row-identifier"]');
    const timestamp = container.querySelector('[data-slot="task-row-timestamp"]');
    expect(taskRow).not.toBeNull();
    expect(taskRow?.className).not.toContain("border-b");
    expect(identifier).not.toBeNull();
    expect(timestamp).not.toBeNull();
    if (!identifier || !timestamp) throw new Error("Expected canonical identifier and timestamp columns");
    expect(identifier.compareDocumentPosition(timestamp) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    act(() => root.unmount());
  });

  it("restores the legacy status/id prefix, timestamp column, and row divider", async () => {
    mockIssuesApi.list.mockResolvedValue([
      makeIssue(
        "issue-legacy",
        "PAP-41",
        "Legacy blocked row",
        attention({ owner: { type: "board", agentId: null, userId: null, label: "Board" } }),
      ),
    ]);

    const { root } = renderWithClient(
      <BlockedInboxView {...blockedViewProps} presentation="legacy" />,
      container,
    );
    await waitFor(() => container.textContent?.includes("Legacy blocked row") === true);

    expect(container.querySelector('[data-slot="task-row"]')).toBeNull();
    expect(container.querySelector('[data-testid="blocked-row-age"]')).not.toBeNull();
    const row = container.querySelector("a")?.parentElement;
    expect(row?.className).toContain("border-b");
    expect(row?.textContent).toContain("PAP-41");

    act(() => root.unmount());
  });

  it("filters rows by search query against title, identifier, owner and action", async () => {
    const issues: Issue[] = [
      makeIssue(
        "issue-1",
        "PAP-77",
        "Resume parked work",
        attention({
          reason: "blocked_by_assigned_backlog_issue",
          owner: { type: "agent", agentId: null, userId: null, label: "Charlie" },
          action: { label: "Resume parked blocker", detail: null },
        }),
      ),
      makeIssue(
        "issue-2",
        "PAP-99",
        "Other unrelated thing",
        attention({
          reason: "external_owner_action",
          owner: { type: "external", agentId: null, userId: null, label: "Vendor" },
          action: { label: "Awaiting Vendor", detail: null },
        }),
      ),
    ];
    mockIssuesApi.list.mockResolvedValue(issues);

    const { root } = renderWithClient(
      <BlockedInboxView
        {...blockedViewProps}
        searchQuery="charlie"
      />,
      container,
    );
    await waitFor(() => container.querySelectorAll("a").length > 0);

    const links = container.querySelectorAll("a");
    const titles = Array.from(links).map((a) => a.textContent ?? "");
    expect(titles.some((t) => t.includes("Resume parked work"))).toBe(true);
    expect(titles.some((t) => t.includes("Other unrelated thing"))).toBe(false);

    act(() => root.unmount());
  });

  it("uses loaded live descendants when blocked inbox rows do not have a server summary", async () => {
    mockIssuesApi.list.mockResolvedValue([
      {
        ...makeIssue(
          "blocked-parent",
          "PAP-77",
          "Blocked parent with active child",
          attention({ reason: "blocked_chain_stalled" }),
        ),
        status: "blocked",
        blockerAttention: null,
        liveDescendantCount: undefined,
      } as unknown as Issue,
    ]);

    const { root } = renderWithClient(
      <BlockedInboxView
        {...blockedViewProps}
        subtreeLiveCounts={new Map([["blocked-parent", 1]])}
      />,
      container,
    );
    await waitFor(() => container.querySelector("a") !== null);

    expect(container.querySelector('[aria-label="Blocked · waiting on 1 active sub-task"]')).not.toBeNull();

    act(() => root.unmount());
  });

  it("renders the visible error banner with retry when the query fails", async () => {
    mockIssuesApi.list.mockRejectedValue(new Error("network down"));

    const { root } = renderWithClient(
      <BlockedInboxView
        {...blockedViewProps}
      />,
      container,
    );
    await waitFor(() =>
      container.querySelector('[data-testid="blocked-inbox-error"]') !== null,
    );

    const banner = container.querySelector('[data-testid="blocked-inbox-error"]');
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute("role")).toBe("alert");
    expect(banner?.textContent).toContain("Couldn't load the Blocked tab");

    act(() => root.unmount());
  });
});
