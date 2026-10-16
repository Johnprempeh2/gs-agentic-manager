// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RecoveryHold } from "@greatstone/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockRecoveryHoldsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockIssuesApi = vi.hoisted(() => ({ resolveRecoveryAction: vi.fn() }));

vi.mock("../api/recoveryHolds", () => ({ recoveryHoldsApi: mockRecoveryHoldsApi }));
vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, className, to }: { children: React.ReactNode; className?: string; to: string }) => (
    <a className={className} href={to}>
      {children}
    </a>
  ),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { RecoveryHoldsPanel } from "./RecoveryHoldsPanel";

function hold(overrides: Partial<RecoveryHold> = {}): RecoveryHold {
  return {
    issue: { id: "issue-1", identifier: "GRE-1094", title: "Push the booking branch", status: "blocked" },
    assigneeAgentId: "ridge",
    recoveryActionId: "action-1",
    runId: "11111111-1111-4111-8111-111111111111",
    cause: "uncertain_provider_action",
    nextAction: "Check whether the last push reached GitHub.",
    heldSince: new Date(Date.now() - 6 * 86_400_000).toISOString(),
    needsWorkspaceRepair: false,
    ...overrides,
  };
}

async function flush() {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function buttonWithText(text: string) {
  return [...document.querySelectorAll("button")].find((button) => button.textContent?.includes(text)) as
    | HTMLButtonElement
    | undefined;
}

describe("RecoveryHoldsPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    mockRecoveryHoldsApi.list.mockReset();
    mockIssuesApi.resolveRecoveryAction.mockReset();
  });

  function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root.render(
        <QueryClientProvider client={client}>
          <RecoveryHoldsPanel companyId="company-1" agentNameById={new Map([["ridge", "Ridge"]])} />
        </QueryClientProvider>,
      );
    });
  }

  it("lists held tasks and clears one with the board's answer", async () => {
    mockRecoveryHoldsApi.list.mockResolvedValue({ holds: [hold()] });
    mockIssuesApi.resolveRecoveryAction.mockResolvedValue({});
    render();
    await flush();

    const row = container.querySelector("[data-testid=recovery-hold-row]")!;
    expect(container.textContent).toContain("1 task is on hold after a run stopped");
    expect(row.textContent).toContain("GRE-1094");
    expect(row.textContent).toContain("Ridge · on hold since 6d ago");

    flushSync(() => buttonWithText("Clear and wake")!.click());
    await flush();
    expect(document.querySelector("[data-testid=clear-hold-dialog]")?.textContent).toContain(
      "Check whether the last push reached GitHub.",
    );
    flushSync(() => buttonWithText("It finished the step")!.click());
    flushSync(() => buttonWithText("Clear and wake Ridge")!.click());
    await flush();

    expect(mockIssuesApi.resolveRecoveryAction).toHaveBeenCalledWith("issue-1", {
      actionId: "action-1",
      outcome: "restored",
      sourceIssueStatus: "todo",
      resolutionNote: "Cleared from the holds list.",
      executionReconciliation: expect.objectContaining({
        runId: "11111111-1111-4111-8111-111111111111",
        providerStopped: true,
        actionOutcome: "completed",
      }),
    });
    expect(container.querySelector("[data-testid=recovery-holds-cleared]")?.textContent).toBe(
      "Cleared GRE-1094. Ridge will pick it up again.",
    );
  });

  it("keeps a task in review in review when its hold is cleared", async () => {
    mockRecoveryHoldsApi.list.mockResolvedValue({
      holds: [hold({ issue: { id: "issue-2", identifier: "GRE-1190", title: "Strategy Board F12", status: "in_review" } })],
    });
    mockIssuesApi.resolveRecoveryAction.mockResolvedValue({});
    render();
    await flush();

    flushSync(() => buttonWithText("Clear and wake")!.click());
    await flush();
    flushSync(() => buttonWithText("It finished the step")!.click());
    flushSync(() => buttonWithText("Clear and wake Ridge")!.click());
    await flush();

    expect(mockIssuesApi.resolveRecoveryAction).toHaveBeenCalledWith(
      "issue-2",
      expect.objectContaining({ outcome: "restored", sourceIssueStatus: "in_review" }),
    );
  });

  it("asks for a workspace note before clearing a hold whose files are unsafe", async () => {
    mockRecoveryHoldsApi.list.mockResolvedValue({ holds: [hold({ needsWorkspaceRepair: true })] });
    render();
    await flush();

    flushSync(() => buttonWithText("Clear and wake")!.click());
    await flush();
    expect(buttonWithText("Clear and wake Ridge")!.disabled).toBe(true);
  });

  it("shows nothing when no task is on hold", async () => {
    mockRecoveryHoldsApi.list.mockResolvedValue({ holds: [] });
    render();
    await flush();
    expect(container.querySelector("[data-testid=recovery-holds]")).toBeNull();
  });
});
