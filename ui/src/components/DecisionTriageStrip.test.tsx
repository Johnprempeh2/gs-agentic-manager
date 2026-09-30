// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AnchorHTMLAttributes, ReactElement, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, AttentionItem } from "@greatstone/shared";
import { issuesApi } from "../api/issues";
import { ToastViewport } from "./ToastViewport";
import { ToastProvider } from "../context/ToastContext";
import { DecisionTriageStrip } from "./DecisionTriageStrip";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    create: vi.fn(),
    addComment: vi.fn(),
  },
}));

// Render menu items inline so the agent picker can be clicked without driving
// Radix pointer events in jsdom.
vi.mock("./ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" data-menu-item onClick={onClick}>{children}</button>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act<T>(cb: () => T): T {
  let result: T | undefined;
  flushSync(() => {
    result = cb();
  });
  return result as T;
}

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

function render(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root?.render(
      <ToastProvider>
        <QueryClientProvider client={client}>
          {element}
          <ToastViewport />
        </QueryClientProvider>
      </ToastProvider>,
    ),
  );
  return container;
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

const everest = { id: "agent-everest", name: "Everest", status: "idle" } as Agent;

function buildItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "a1",
    companyId: "c1",
    sourceKind: "issue_thread_interaction",
    subject: {
      kind: "interaction",
      id: "interaction-1",
      companyId: "c1",
      title: "Pick a hosting provider",
      identifier: null,
      status: "pending",
      href: null,
      metadata: {},
    },
    whyNow: "Waiting on a board answer.",
    decisionVerbs: [],
    inlineResolvable: false,
    entryRule: "",
    exitRule: "",
    dedupKey: "interaction:interaction-1",
    dismissalKey: "attention:interaction:interaction-1",
    severity: "high",
    rank: 0,
    activityAt: "2026-09-29T12:00:00Z",
    createdAt: "2026-09-29T12:00:00Z",
    updatedAt: "2026-09-29T12:00:00Z",
    relatedIssue: {
      kind: "issue",
      id: "issue-219",
      companyId: "c1",
      title: "Hosting",
      identifier: "GRE-219",
      status: "in_progress",
      href: "/issues/GRE-219",
    },
    project: null,
    workspace: null,
    detail: null,
    dismissal: null,
    expiresAt: null,
    ruleKey: null,
    originAgentName: null,
    queues: [],
    shelf: false,
    retentionDays: 30,
    keep: false,
    archivedAt: null,
    retentionVersion: 1,
    decideBy: null,
    decideByAttribution: null,
    snoozedUntil: null,
    trainingExampleId: null,
    ...overrides,
  };
}

function askButton(el: HTMLElement) {
  return Array.from(el.querySelectorAll("button")).find((button) =>
    button.textContent?.includes("Ask agent for recommendation"),
  ) as HTMLButtonElement;
}

describe("DecisionTriageStrip — ask agent for a recommendation", () => {
  it("creates a child task of the linked task assigned to the agent, and links it in the toast", async () => {
    vi.mocked(issuesApi.create).mockResolvedValue({ id: "issue-300", identifier: "GRE-300" } as never);
    const el = render(<DecisionTriageStrip item={buildItem()} companyId="c1" agents={[everest]} />);

    const item = Array.from(el.querySelectorAll("[data-menu-item]")).find(
      (node) => node.textContent === "Everest",
    ) as HTMLButtonElement;
    act(() => item.click());
    await flush();

    expect(issuesApi.create).toHaveBeenCalledTimes(1);
    const [companyId, payload] = vi.mocked(issuesApi.create).mock.calls[0]!;
    expect(companyId).toBe("c1");
    expect(payload).toMatchObject({
      parentId: "issue-219",
      assigneeAgentId: "agent-everest",
      status: "todo",
      title: "Recommend: Pick a hosting provider",
    });
    const description = String(payload.description);
    expect(description).toContain("Pick a hosting provider");
    expect(description).toContain("GRE-219");
    expect(description).toContain("prepare a recommendation, and re-surface it on the decisions desk");
    // Assignment is the wake; no @mention comment is posted.
    expect(issuesApi.addComment).not.toHaveBeenCalled();
    expect(description).not.toContain("[@");

    expect(el.textContent).toContain("Asked Everest for a recommendation in GRE-300");
    const link = el.querySelector('a[href="/issues/GRE-300"]');
    expect(link?.textContent).toContain("View GRE-300");
  });

  it("keeps the no-linked-task error and creates nothing when the decision has no linked task", async () => {
    const el = render(
      <DecisionTriageStrip item={buildItem({ relatedIssue: null })} companyId="c1" agents={[everest]} />,
    );

    const button = askButton(el);
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("No linked task to ask about");

    const item = Array.from(el.querySelectorAll("[data-menu-item]")).find(
      (node) => node.textContent === "Everest",
    ) as HTMLButtonElement;
    act(() => item.click());
    await flush();

    expect(issuesApi.create).not.toHaveBeenCalled();
    expect(el.textContent).toContain("This decision has no linked task to route from.");
  });
});
