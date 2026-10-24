// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskRunStateChip } from "./TaskRunStateChip";
import type { TaskRunState } from "../lib/task-run-state";

const mockIssuesApi = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-10-24T15:00:00.000Z");
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  mockIssuesApi.get.mockReset();
});

async function render(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  });
}

const chip = () => container.querySelector("[data-testid='task-run-state-chip']")!;
/** The visible chip words, without the screen-reader detail. */
const chipLabel = () => chip().querySelector("span")?.textContent;
const spins = () => chip().querySelector("svg")?.getAttribute("class")?.includes("animate-spin") === true;

const running: TaskRunState = {
  kind: "running",
  runId: "r1",
  agentId: "lintel",
  agentName: "Lintel",
  startedAt: ago(4 * MIN),
  lastOutputAt: ago(20_000),
  silentMs: 20_000,
};

const queued: TaskRunState = {
  kind: "queued",
  runId: "r2",
  agentId: "lintel",
  agentName: "Lintel",
  reason: { kind: "behind", blockingIssueId: "issue-2217", blockingRunId: "r1", maxConcurrentRuns: 1 },
  position: 2,
  queueLength: 3,
};

describe("TaskRunStateChip", () => {
  it("running: Working with a spinner, elapsed time and last output", async () => {
    await render(<TaskRunStateChip state={running} variant="full" />);
    expect(chip().getAttribute("data-run-state")).toBe("running");
    expect(chipLabel()).toBe("Working");
    expect(spins()).toBe(true);
    expect(container.textContent).toContain("4 min · last output 20s ago");
  });

  it("queued: a calm chip, no spinner, the reason and a link to the blocking task", async () => {
    await render(
      <TaskRunStateChip state={queued} variant="full" issueLabel={(id) => (id === "issue-2217" ? "GRE-2217" : null)} />,
    );
    expect(chipLabel()).toBe("Queued");
    expect(spins()).toBe(false);
    expect(container.textContent).toContain("Behind GRE-2217 (Lintel runs 1 at a time) · 2nd of 3 waiting");
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/issues/issue-2217");
    expect(link?.textContent).toBe("GRE-2217");
    expect(mockIssuesApi.get).not.toHaveBeenCalled();
  });

  it("queued: looks up the blocking task's name when the caller does not know it", async () => {
    mockIssuesApi.get.mockResolvedValue({ id: "issue-2217", identifier: "GRE-2217" });
    await render(<TaskRunStateChip state={queued} variant="full" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(mockIssuesApi.get).toHaveBeenCalledWith("issue-2217");
    expect(container.querySelector("a")?.textContent).toBe("GRE-2217");
  });

  it("compact rows keep the why in the tooltip, with no nested link", async () => {
    await render(<TaskRunStateChip state={queued} issueLabel={() => "GRE-2217"} />);
    expect(container.querySelector("a")).toBeNull();
    expect(chip().getAttribute("title")).toBe("Queued · Behind GRE-2217 (Lintel runs 1 at a time) · 2nd of 3 waiting");
  });

  it("stuck: a running run silent for 10+ minutes shows a quiet warning", async () => {
    await render(<TaskRunStateChip state={{ ...running, lastOutputAt: ago(12 * MIN), silentMs: 12 * MIN }} />);
    expect(chip().getAttribute("data-run-state")).toBe("stuck");
    expect(chipLabel()).toBe("No output for 12 min");
    expect(spins()).toBe(false);
  });

  it("stuck: tree cards use the short label so the owner name fits", async () => {
    await render(<TaskRunStateChip state={{ ...running, lastOutputAt: ago(12 * MIN), silentMs: 12 * MIN }} short />);
    expect(chipLabel()).toBe("No output 12 min");
  });

  it("turns stuck on its own as the silence passes 10 minutes", async () => {
    await render(<TaskRunStateChip state={{ ...running, lastOutputAt: ago(9 * MIN + 58_000), silentMs: 9 * MIN }} />);
    expect(chip().getAttribute("data-run-state")).toBe("running");
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    expect(chip().getAttribute("data-run-state")).toBe("stuck");
  });
});
