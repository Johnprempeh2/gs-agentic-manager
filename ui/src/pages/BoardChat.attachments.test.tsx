// @vitest-environment jsdom

import { act, forwardRef, useImperativeHandle } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardChat } from "./BoardChat";

/**
 * Files on a board chat message (uploads throughout the journey, 16 Oct):
 * each file uploads to the board conversation as it is added, and the
 * message carries their ids so the assistant can read them.
 */

const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockGoalsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockIssuesApi = vi.hoisted(() => ({
  list: vi.fn(),
  listComments: vi.fn(),
  listFeedbackVotes: vi.fn(),
  uploadAttachment: vi.fn(),
}));
const mockBoardChatApi = vi.hoisted(() => ({ ensureIssue: vi.fn() }));
const composer = vi.hoisted(() => ({ props: null as null | Record<string, any> }));
const mockDialogState = vi.hoisted(() => ({ onboardingOpen: false }));

vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/goals", () => ({ goalsApi: mockGoalsApi }));
vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("../api/boardChat", () => ({ boardChatApi: mockBoardChatApi, MAX_BOARD_CHAT_ATTACHMENTS: 5 }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Acme Robotics", issuePrefix: "PAP" },
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogState: () => ({ onboardingOpen: mockDialogState.onboardingOpen }),
}));

// Heavy children that are irrelevant to the staged intro.
vi.mock("../components/ActivityFeed", () => ({
  ActivityFeed: () => <div data-testid="activity-feed" />,
}));
vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/ChatComposer", () => ({
  ChatComposer: forwardRef((props: Record<string, any>, ref) => {
    composer.props = props;
    useImperativeHandle(ref, () => ({ focus: vi.fn() }));
    return <div data-testid="chat-composer" />;
  }),
}));
vi.mock("../components/AgentBubbleActionRow", () => ({
  AgentBubbleActionRow: () => null,
  agentBubbleDateLabel: () => "",
}));
vi.mock("../components/AgentIconPicker", () => ({
  AgentIcon: () => null,
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SheetContent: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

async function flush() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("BoardChat attachments", () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    vi.stubGlobal("fetch", fetchMock);
    Element.prototype.scrollIntoView = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockAgentsApi.list.mockResolvedValue([]);
    mockGoalsApi.list.mockResolvedValue([]);
    mockIssuesApi.list.mockResolvedValue([]);
    mockIssuesApi.listComments.mockResolvedValue([]);
    mockIssuesApi.listFeedbackVotes.mockResolvedValue([]);
    mockBoardChatApi.ensureIssue.mockResolvedValue({ issueId: "issue-board" });
    mockIssuesApi.uploadAttachment.mockResolvedValue({ id: "att-1", contentPath: "/api/attachments/att-1/content" });
    fetchMock.mockResolvedValue({ ok: false, status: 500, body: null });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("uploads files to the board conversation and sends their ids with the message", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <BoardChat />
        </QueryClientProvider>,
      );
    });
    await flush();
    expect(composer.props?.onAttachFiles).toBeTypeOf("function");

    const file = new File(["numbers"], "Q3.csv", { type: "text/csv" });
    await act(async () => {
      await composer.props!.onAttachFiles([file]);
    });
    await flush();
    expect(mockBoardChatApi.ensureIssue).toHaveBeenCalledWith("company-1");
    expect(mockIssuesApi.uploadAttachment).toHaveBeenCalledWith("company-1", "issue-board", file);
    expect(composer.props!.attachments).toEqual([
      expect.objectContaining({ name: "Q3.csv", status: "attached", attachmentId: "att-1" }),
    ]);

    await act(async () => composer.props!.onChange("What do these show?"));
    await flush();
    await act(async () => composer.props!.onSubmit());
    await flush();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/board/chat/stream");
    expect(JSON.parse(init.body)).toEqual({
      companyId: "company-1",
      message: "What do these show?",
      taskId: "issue-board",
      attachmentIds: ["att-1"],
    });
    expect(composer.props!.attachments).toEqual([]);
  });

  it("refuses a sixth file on one message", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <BoardChat />
        </QueryClientProvider>,
      );
    });
    await flush();
    const files = Array.from({ length: 6 }, (_, index) => new File(["x"], `f${index}.txt`));
    await act(async () => {
      await composer.props!.onAttachFiles(files);
    });
    await flush();
    expect(mockIssuesApi.uploadAttachment).toHaveBeenCalledTimes(5);
    expect(composer.props!.attachments.at(-1)).toEqual(
      expect.objectContaining({ name: "f5.txt", status: "error", error: "Up to 5 files per message" }),
    );
  });
});
