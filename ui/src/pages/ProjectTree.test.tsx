// @vitest-environment jsdom

import type { AnchorHTMLAttributes, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IssueTreeNode, ProjectTree as ProjectTreeData } from "@greatstone/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectTree } from "./ProjectTree";

const navigateMock = vi.fn();
const setBreadcrumbsMock = vi.fn();
const pushToastMock = vi.fn();
const getTreeMock = vi.fn();
const tidyMock = vi.fn();
let phone = false;
let tree: ProjectTreeData;

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => navigateMock,
  useParams: () => ({ projectId: "platform" }),
  useLocation: () => ({ pathname: "/projects/platform/tree", search: "", hash: "", state: null }),
}));
vi.mock("../hooks/useIsPhone", () => ({ useIsPhone: () => phone }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }) }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: pushToastMock }) }));
vi.mock("../api/auth", () => ({ authApi: { getSession: async () => ({ user: { id: "user-john" } }) } }));
vi.mock("../api/agents", () => ({
  agentsApi: {
    list: async () => [
      { id: "agent-flint", name: "Flint", appearance: null },
      { id: "agent-mica", name: "Mica", appearance: null },
    ],
  },
}));
vi.mock("../api/access", () => ({ accessApi: { listUserDirectory: async () => ({ users: [] }) } }));
vi.mock("../api/projects", () => ({
  projectsApi: {
    get: async () => ({ id: "p-1", companyId: "company-1", name: "Platform", urlKey: "platform" }),
    getTree: (...args: unknown[]) => getTreeMock(...args),
    tidy: (...args: unknown[]) => tidyMock(...args),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;

function node(id: string, parentId: string | null, values: Partial<IssueTreeNode> = {}): IssueTreeNode {
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
    blockedByIds: [],
    childCount: 0,
    doneChildCount: 0,
    terminalBlockerId: null,
    unblockAction: null,
    isKeyTask: false,
    updatedAt: new Date("2026-10-20T09:00:00Z"),
    ...values,
  };
}

let container: HTMLDivElement;
let root: Root;

async function flush() {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ProjectTree />
      </QueryClientProvider>,
    );
  });
  await flush();
}

function nodeIds() {
  return [...container.querySelectorAll("[data-tree-node]")].map((el) => el.getAttribute("data-tree-node")).sort();
}

const ROOT = "project:p-1";
const UNSORTED = "project:p-1:unsorted";

beforeEach(() => {
  phone = false;
  navigateMock.mockReset();
  pushToastMock.mockReset();
  tidyMock.mockReset();
  tidyMock.mockResolvedValue({ status: "created", taskId: "tidy-1", agentId: "agent-flint" });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // Ship billing (10, key) holds open work and 3 finished tasks; Launch site
  // (20, key) is all done; Loose idea (30) sits under no key task.
  tree = {
    project: { id: "p-1", name: "Platform", status: "in_progress", lead: { agentId: "agent-flint", covering: false } },
    keyTaskIds: ["10", "20"],
    unsortedIds: ["30"],
    nodes: [
      node("10", null, { title: "Ship billing", status: "in_progress", isKeyTask: true, childCount: 3, doneChildCount: 2 }),
      node("11", "10", { title: "Invoices", assigneeAgentId: "agent-mica" }),
      node("12", "11", { title: "Tax rules", status: "blocked", blockedByIds: ["30"] }),
      node("20", null, { title: "Launch site", status: "done", isKeyTask: true }),
      node("30", null, { title: "Loose idea" }),
    ],
    externalBlockers: [],
    hiddenDoneByParent: { "10": 3, "20": 1 },
    keyTaskProgress: { "10": { done: 3, total: 5 }, "20": { done: 1, total: 1 } },
    counts: { done: 5, active: 1, blocked: 1, waiting: 1 },
    openTidyTaskId: null,
    truncated: false,
    limits: { maxNodes: 300, maxDepth: 12 },
  };
  getTreeMock.mockReset();
  getTreeMock.mockImplementation(async () => tree);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

describe("Project tree page", () => {
  it("draws the project, its key tasks as branches and the unsorted work", async () => {
    await renderPage();
    const header = container.querySelector('[data-slot="task-tree-header"]')!;
    expect(header.querySelector("h1")?.textContent).toBe("Platform");
    expect(header.textContent).toContain("5 of 8 done");
    expect(header.querySelector("[data-project-lead]")?.textContent).toContain("Flint");
    expect(header.querySelector("[data-project-lead]")?.textContent).not.toContain("covering");
    expect(setBreadcrumbsMock).toHaveBeenLastCalledWith([
      { label: "Projects", href: "/projects" },
      { label: "Platform", href: "/projects/platform/issues" },
      { label: "Tree" },
    ]);

    // Finished work is folded: Launch site (and its hidden task) under the
    // project, Ship billing's three finished tasks under it.
    expect(nodeIds()).toEqual([ROOT, `${ROOT}:done`, UNSORTED, "10", "10:done", "11", "12", "30"].sort());
    expect(container.querySelector(`[data-tree-node="${ROOT}:done"]`)?.textContent).toContain("+2 done");
    expect(container.querySelector('[data-tree-node="10:done"]')?.textContent).toContain("+3 done");
    // Key tasks are marked and their ring counts the whole branch.
    const keyCard = container.querySelector('[data-tree-node="10"]')!;
    expect(keyCard.querySelector("[data-key-task]")).not.toBeNull();
    expect(keyCard.querySelector('[aria-label="3 of 5 sub-tasks done"]')).not.toBeNull();
    expect(container.querySelector(`[data-tree-node="${UNSORTED}"]`)?.textContent).toContain("Unsorted: 1 open task");
    // The blocked path runs from Tax rules to the unsorted task it waits on.
    expect(container.querySelector('[data-tree-node="12"]')?.textContent).toContain("Blocked by GRE-30");
  });

  it("folds and unfolds a branch", async () => {
    await renderPage();
    const toggle = container.querySelector('[data-tree-node="10"] [data-tree-toggle]') as HTMLButtonElement;
    flushSync(() => toggle.click());
    await flush();
    expect(nodeIds()).not.toContain("11");
    expect(container.querySelector('[data-tree-node="10"] [data-tree-toggle]')?.textContent).toContain("5");
    flushSync(() => (container.querySelector('[data-tree-node="10"] [data-tree-toggle]') as HTMLButtonElement).click());
    await flush();
    expect(nodeIds()).toContain("11");
  });

  it("opens a task on its own view, and the project card opens the task list", async () => {
    await renderPage();
    flushSync(() => (container.querySelector('[data-tree-node="11"]') as HTMLElement).click());
    expect(navigateMock).toHaveBeenLastCalledWith("/issues/GRE-11");
    flushSync(() => (container.querySelector(`[data-tree-node="${ROOT}"]`) as HTMLElement).click());
    expect(navigateMock).toHaveBeenLastCalledWith("/projects/platform/issues");
  });

  it("asks the lead to tidy from the Unsorted card without opening it", async () => {
    await renderPage();
    const button = container.querySelector(`[data-tree-node="${UNSORTED}"] [data-tidy-button]`) as HTMLButtonElement;
    expect(button.textContent).toContain("Tidy");
    flushSync(() => button.click());
    await flush();
    expect(tidyMock).toHaveBeenCalledWith("p-1");
    expect(navigateMock).not.toHaveBeenCalled();
    expect(pushToastMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Tidy asked", tone: "success" }));
  });

  it("links to the open tidy instead of asking again", async () => {
    tree = { ...tree, openTidyTaskId: "tidy-1" };
    await renderPage();
    expect(container.querySelector("[data-tidy-button]")).toBeNull();
    const link = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent === "Tidy asked");
    expect(link?.getAttribute("href")).toBe("/issues/tidy-1?view=task");
  });

  it("fetches finished work when asked", async () => {
    await renderPage();
    expect(getTreeMock).toHaveBeenLastCalledWith("p-1", false);
    flushSync(() => (container.querySelector('[data-tree-node="10:done"]') as HTMLButtonElement).click());
    await flush();
    expect(getTreeMock).toHaveBeenLastCalledWith("p-1", true);
  });

  it("says when the company lead covers a project with no lead, and when nothing is key yet", async () => {
    tree = {
      ...tree,
      project: { ...tree.project, lead: { agentId: "agent-flint", covering: true } },
      keyTaskIds: [],
      nodes: tree.nodes.filter((entry) => entry.id === "30"),
    };
    await renderPage();
    expect(container.querySelector("[data-project-lead]")?.textContent).toContain("covering");
    expect(container.querySelector("[data-no-key-tasks]")).not.toBeNull();
  });

  it("shows an outline with the Tidy button on a phone", async () => {
    phone = true;
    await renderPage();
    expect(container.querySelector('[data-slot="task-tree-canvas"]')).toBeNull();
    const outline = container.querySelector('[data-slot="task-tree-outline"]')!;
    const rows = [...outline.querySelectorAll("[data-outline-node]")].map((row) => row.getAttribute("data-outline-node"));
    expect(rows).toEqual(expect.arrayContaining([ROOT, UNSORTED, "10", "11", "12", "30"]));
    expect(outline.querySelector('[data-outline-node="11"] a')?.getAttribute("href")).toBe("/issues/GRE-11");
    expect(outline.querySelector("[data-tidy-button]")).not.toBeNull();
    expect(outline.querySelector('[data-outline-node="10"] [data-key-task]')).not.toBeNull();
  });
});
