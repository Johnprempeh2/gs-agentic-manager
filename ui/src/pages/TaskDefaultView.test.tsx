// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import type { IssueTree, IssueTreeNode } from "@greatstone/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskDefaultView } from "./TaskDefaultView";

const getTreeMock = vi.fn();
vi.mock("../api/issues", () => ({ issuesApi: { getTree: (id: string) => getTreeMock(id) } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: null }) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;

function node(id: string, parentId: string | null, blockedByIds: string[] = []): IssueTreeNode {
  return {
    id,
    identifier: `GRE-${id}`,
    title: `Task ${id}`,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    parentId,
    depth: parentId ? 1 : 0,
    blockedByIds,
    childCount: 0,
    doneChildCount: 0,
    terminalBlockerId: null,
    unblockAction: null,
    updatedAt: new Date("2026-10-21T09:00:00Z"),
  };
}

function treeOf(...nodes: IssueTreeNode[]): IssueTree {
  return { rootId: nodes[0]!.id, nodes, externalBlockers: [], truncated: false, limits: { maxNodes: 300, maxDepth: 12 } };
}

let container: HTMLDivElement;
let root: Root;
let navigate: ReturnType<typeof useNavigate>;

function Probe() {
  const location = useLocation();
  navigate = useNavigate();
  return <output data-at={`${location.pathname}${location.search}${location.hash}`} />;
}

async function flush() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function open(entries: string[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
          <Routes>
            <Route path="/desk" element={<p data-page="desk" />} />
            <Route path="/issues/:issueId" element={<TaskDefaultView task={<p data-page="task" />} />} />
            <Route path="/issues/:issueId/tree" element={<p data-page="tree" />} />
          </Routes>
          <Probe />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}

const page = () => container.querySelector("[data-page]")?.getAttribute("data-page");
const at = () => container.querySelector("output")?.getAttribute("data-at");

beforeEach(() => {
  getTreeMock.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

describe("TaskDefaultView", () => {
  it("opens a task with sub-tasks on its tree, and Back returns to where the link was", async () => {
    getTreeMock.mockResolvedValue(treeOf(node("1", null), node("2", "1")));
    await open(["/desk", "/issues/GRE-1"]);
    expect(page()).toBe("tree");
    expect(at()).toBe("/issues/GRE-1/tree");

    flushSync(() => navigate(-1));
    await flush();
    expect(page()).toBe("desk");
  });

  it("opens a task with only a blocker on its tree", async () => {
    getTreeMock.mockResolvedValue(treeOf(node("1", null, ["9"])));
    await open(["/issues/GRE-1"]);
    expect(page()).toBe("tree");
  });

  it("opens a lone task on the task page", async () => {
    getTreeMock.mockResolvedValue(treeOf(node("1", null)));
    await open(["/issues/GRE-1"]);
    expect(page()).toBe("task");
    expect(at()).toBe("/issues/GRE-1");
  });

  it("keeps ?view=task on the task page, and Back from there returns to the tree", async () => {
    getTreeMock.mockResolvedValue(treeOf(node("1", null), node("2", "1")));
    await open(["/desk", "/issues/GRE-1"]);
    expect(page()).toBe("tree");

    flushSync(() => navigate("/issues/GRE-1?view=task"));
    await flush();
    expect(page()).toBe("task");
    expect(at()).toBe("/issues/GRE-1?view=task");

    flushSync(() => navigate(-1));
    await flush();
    expect(page()).toBe("tree");
  });

  it("opens a comment deep link on the task page, without asking for the tree", async () => {
    getTreeMock.mockResolvedValue(treeOf(node("1", null), node("2", "1")));
    await open(["/issues/GRE-1#comment-abc"]);
    expect(page()).toBe("task");
    expect(getTreeMock).not.toHaveBeenCalled();
  });

  it("falls back to the task page when the tree does not load", async () => {
    getTreeMock.mockRejectedValue(new Error("boom"));
    await open(["/issues/GRE-1"]);
    expect(page()).toBe("task");
  });
});
