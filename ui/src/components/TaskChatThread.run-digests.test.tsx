// @vitest-environment jsdom

import type { ReactElement } from "react";
import { act, forwardRef, useImperativeHandle, type ForwardedRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { buildRunLogTranscriptDigest } from "@greatstone/adapter-utils/run-log-transcript";
import { ThemeProvider } from "@/context/ThemeContext";
import { ApiError } from "@/api/client";
import { getUIAdapter } from "@/adapters";
import { TaskChatThread } from "./TaskChatThread";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// The real transcript hooks run here; only the network is faked.
const api = vi.hoisted(() => ({
  log: vi.fn(),
  transcriptDigests: vi.fn(),
}));
vi.mock("@/api/heartbeats", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/heartbeats")>();
  return {
    ...actual,
    heartbeatsApi: { ...actual.heartbeatsApi, log: api.log, transcriptDigests: api.transcriptDigests },
  };
});
vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: { getGeneral: async () => ({ censorUsernameInLogs: false }) },
}));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("@/hooks/useIssuePlanDocument", () => ({ useIssuePlanDocument: () => ({ data: null }) }));
vi.mock("@/hooks/useStreamlinedUiEnabled", () => ({
  useStreamlinedUiEnabled: () => ({ enabled: true, loaded: true }),
}));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));
vi.mock("@/components/MarkdownEditor", () => ({
  MarkdownEditor: forwardRef(function MockMarkdownEditor(
    { value }: { value: string },
    ref: ForwardedRef<unknown>,
  ) {
    useImperativeHandle(ref, () => ({ insertMarkdown: () => {}, focus: () => {} }));
    return <div data-testid="mock-editor">{value}</div>;
  }),
}));

// ---------------------------------------------------------------------------
// Fixture: six finished Claude runs written the way the ACP engine logs them.
// ---------------------------------------------------------------------------

function logOf(lines: Array<[ts: string, line: unknown]>, splitAt?: number) {
  const records: string[] = [];
  let seq = 0;
  for (const [index, [ts, line]] of lines.entries()) {
    const text = `${typeof line === "string" ? line : JSON.stringify(line)}\n`;
    // One record split across two chunks, as a pipe read can split it.
    const parts = index === splitAt ? [text.slice(0, 20), text.slice(20)] : [text];
    for (const chunk of parts) {
      records.push(JSON.stringify({ ts, stream: "stdout", chunk, seq: ++seq }));
    }
  }
  return `${records.join("\n")}\n`;
}

const at = (time: string) => `2026-09-30T${time}.000Z`;
const session = { type: "acpx.session", agent: "claude", sessionId: "s-1", mode: "persistent" };
const tool = (id: string, name: string, status: string, extra: Record<string, unknown> = {}) =>
  ({ type: "acpx.tool_call", toolCallId: id, name, status, ...extra });
const say = (text: string) => ({ type: "acpx.text_delta", text, stream: "output" });
const usage = (inputTokens: number, outputTokens: number) =>
  ({ type: "acpx.result", inputTokens, outputTokens, stopReason: "end_turn" });

const LOGS: Record<string, string> = {
  "run-a": logOf([
    [at("18:00:01"), session],
    [at("18:00:02"), say("Reading the config first.")],
    [at("18:00:03"), tool("a1", "Read", "pending", { input: { file_path: "/Users/john/app/config.ts" } })],
    [at("18:00:04"), tool("a1", "Read", "completed", { text: "export const config = { secret: 1 };" })],
    [at("18:00:05"), tool("a2", "Terminal", "pending", { input: { command: "pnpm test" } })],
    [at("18:00:20"), tool("a2", "pnpm test", "completed", { text: "42 passed" })],
    [at("18:00:30"), { type: "acpx.status", text: "wrapping up", used: 10, size: 100 }],
    [at("18:00:40"), say("All green.")],
    [at("18:00:50"), usage(1200, 340)],
  ], 3),
  "run-b": logOf([
    [at("18:05:01"), session],
    [at("18:05:02"), tool("b1", "Edit", "pending", { input: { file_path: "src/b.ts" } })],
    [at("18:05:30"), tool("b1", "Edit", "failed", { text: "permission denied" })],
    [at("18:05:40"), { type: "acpx.error", message: "adapter exited" }],
  ]),
  "run-d": logOf([
    [at("18:15:01"), say("Nothing to do here.")],
  ]),
  "run-e": logOf([
    [at("18:20:01"), session],
    [at("18:20:05"), tool("e1", "Read", "completed", { text: "first half" })],
    [at("18:20:10"), tool("e2", "Grep", "completed", { text: "match" })],
    [at("18:20:40"), say("Picking up your note.")],
    [at("18:20:45"), tool("e3", "Edit", "completed", { text: "patched" })],
    [at("18:20:50"), usage(800, 100)],
  ]),
};

const run = (runId: string, status: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({
  runId,
  runtimeMode: "legacy" as const,
  status,
  agentId: "agent-1",
  agentName: "Coder",
  adapterType: "claude_local",
  createdAt: at(start),
  startedAt: at(start),
  finishedAt: at(end),
  logBytes: LOGS[runId]?.length ?? 0,
  ...extra,
});

const LINKED_RUNS = [
  run("run-e", "succeeded", "18:20:00", "18:21:00"),
  run("run-f", "succeeded", "18:10:00", "18:10:30"),
  run("run-d", "succeeded", "18:15:00", "18:15:30"),
  run("run-c", "cancelled", "18:08:00", "18:08:10"),
  run("run-b", "failed", "18:05:00", "18:06:00", { errorCode: "adapter_failed" }),
  run("run-a", "succeeded", "18:00:00", "18:01:00"),
];

const comment = (id: string, time: string, body: string, extra: Record<string, unknown> = {}) => ({
  id,
  companyId: "company-1",
  issueId: "issue-1",
  authorType: "user" as const,
  authorAgentId: null,
  authorUserId: "user-1",
  body,
  presentation: null,
  metadata: null,
  createdAt: new Date(at(time)),
  updatedAt: new Date(at(time)),
  ...extra,
});

const COMMENTS = [
  comment("c-1", "17:59:00", "Please check the config."),
  comment("c-2", "18:01:05", "Config is fine, tests pass.", {
    authorType: "agent",
    authorAgentId: "agent-1",
    authorUserId: null,
    runId: "run-a",
  }),
  // Lands inside run-e, so its activity splits into two rows.
  comment("c-3", "18:20:30", "Also patch the edit path."),
];

function digestsFor(runIds: readonly string[]) {
  const parser = getUIAdapter("claude_local");
  return {
    digests: Object.fromEntries(
      runIds.map((id) => [id, buildRunLogTranscriptDigest(id, LOGS[id] ?? "", parser)]),
    ),
  };
}

// ---------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root | null = null;
let queryClient: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.log.mockReset();
  api.log.mockImplementation(async (runId: string, offset: number) => {
    const content = LOGS[runId];
    if (content === undefined) throw new ApiError("Run log not found", 404, { error: "Run log not found" });
    const slice = content.slice(offset);
    return { runId, store: "local_file", logRef: runId, content: slice, nextOffset: offset + slice.length };
  });
  api.transcriptDigests.mockReset();
});

afterEach(() => {
  flushSync(() => root?.unmount());
  queryClient.clear();
  root = null;
  container.remove();
  vi.restoreAllMocks();
});

async function settle() {
  for (let round = 0; round < 6; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderThread(ui: ReactElement) {
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>{ui}</ThemeProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
}

function thread(extra: Record<string, unknown> = {}) {
  return (
    <TaskChatThread
      issueId="issue-1"
      comments={COMMENTS}
      onAdd={async () => {}}
      linkedRuns={LINKED_RUNS}
      issueStatus="done"
      {...extra}
    />
  );
}

function threadText() {
  return container.querySelector('[data-testid="task-chat-thread"]')?.textContent ?? "";
}

function summaryRows() {
  return [...container.querySelectorAll('[data-testid="task-chat-turn-summary"]')].map(
    (row) => row.textContent ?? "",
  );
}

const loggedRunIds = () => api.log.mock.calls.map((call) => call[0] as string);

describe("task thread run digests", () => {
  it("draws every folded row and marker exactly as the full logs do", async () => {
    api.transcriptDigests.mockRejectedValue(new ApiError("Not found", 404, null));
    await renderThread(thread());
    const fromLogs = { text: threadText(), rows: summaryRows() };
    expect(new Set(loggedRunIds())).toEqual(new Set(["run-a", "run-b", "run-c", "run-d", "run-e", "run-f"]));

    flushSync(() => root!.unmount());
    root = createRoot(container);
    queryClient.clear();
    api.log.mockClear();
    api.transcriptDigests.mockImplementation(async (_issueId: string, runIds: string[]) => digestsFor(runIds));
    await renderThread(thread());

    // The fixture covers each folded shape: two back-to-back runs merged into
    // one Stopped row, a run split by a mid-run message, a run with no row,
    // and the failed, stopped and completed markers.
    expect(fromLogs.rows).toEqual([
      expect.stringContaining("3 tools · 1.5k tokens"),
      expect.stringContaining("2 tools"),
      expect.stringContaining("1 tool · 900 tokens"),
    ]);
    expect(fromLogs.rows[0]).toContain("Stopped");
    for (const marker of ["Run failed", "Execution was stopped", "Run completed"]) {
      expect(fromLogs.text).toContain(marker);
    }
    expect(fromLogs.text).not.toContain("Nothing to do here.");
    expect(summaryRows()).toEqual(fromLogs.rows);
    expect(threadText()).toBe(fromLogs.text);
  });

  it("downloads no log for a folded finished run", async () => {
    api.transcriptDigests.mockImplementation(async (_issueId: string, runIds: string[]) => digestsFor(runIds));
    await renderThread(thread());

    expect(api.transcriptDigests).toHaveBeenCalledTimes(1);
    expect(api.transcriptDigests.mock.calls[0]?.[1]).toEqual(
      ["run-a", "run-b", "run-c", "run-d", "run-e", "run-f"],
    );
    expect(summaryRows()).toHaveLength(3);
    expect(api.log).not.toHaveBeenCalled();
  });

  function rowWith(text: string) {
    const row = [...container.querySelectorAll<HTMLButtonElement>('button[data-testid="task-chat-turn-summary"]')]
      .find((button) => button.textContent?.includes(text));
    expect(row).toBeDefined();
    return row!;
  }

  it("loads only the opened row's log and then shows its activity", async () => {
    api.transcriptDigests.mockImplementation(async (_issueId: string, runIds: string[]) => digestsFor(runIds));
    await renderThread(thread());
    const row = rowWith("900 tokens");

    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = api.log.getMockImplementation()!;
    api.log.mockImplementation(async (...args: unknown[]) => {
      await gate;
      return read(...args);
    });
    await act(async () => row.click());
    const turn = row.closest('[data-testid="task-chat-turn"]')!;
    expect(turn.querySelector('[data-testid="task-chat-turn-history-loading"]')).not.toBeNull();
    expect(loggedRunIds()).toEqual(["run-e"]);

    await act(async () => release!());
    await settle();
    expect(loggedRunIds()).toEqual(["run-e"]);
    expect(turn.querySelector('[data-testid="task-chat-turn-history-loading"]')).toBeNull();
    expect(turn.querySelector(".tc-turn-fold")?.textContent).toContain("Picking up your note.");
    // The row reads the same once its real activity is in.
    expect(rowWith("900 tokens").textContent).toBe(row.textContent);
  });

  it("loads every run behind a merged row", async () => {
    api.transcriptDigests.mockImplementation(async (_issueId: string, runIds: string[]) => digestsFor(runIds));
    await renderThread(thread());
    await act(async () => rowWith("1.5k tokens").click());
    await settle();
    expect(new Set(loggedRunIds())).toEqual(new Set(["run-a", "run-b"]));
    expect(rowWith("1.5k tokens").closest('[data-testid="task-chat-turn"]')?.textContent)
      .toContain("Reading the config first.");
  });

  it("still reads a live run's log while finished runs stay folded", async () => {
    api.transcriptDigests.mockImplementation(async (_issueId: string, runIds: string[]) => digestsFor(runIds));
    LOGS["run-live"] = logOf([[at("18:30:01"), say("Working on it.")]]);
    try {
      await renderThread(
        thread({
          issueStatus: "in_progress",
          liveRuns: [{
            id: "run-live",
            status: "running",
            runtimeMode: "legacy",
            adapterType: "claude_local",
            agentId: "agent-1",
            agentName: "Coder",
            invocationSource: "assignment",
            triggerDetail: null,
            createdAt: at("18:30:00"),
            startedAt: at("18:30:00"),
            finishedAt: null,
            issueId: "issue-1",
            logBytes: LOGS["run-live"].length,
          }],
        }),
      );
      expect(loggedRunIds()).toEqual(["run-live"]);
      expect(threadText()).toContain("Working on it.");
    } finally {
      delete LOGS["run-live"];
    }
  });
});
