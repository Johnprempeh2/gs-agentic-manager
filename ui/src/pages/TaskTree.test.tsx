// @vitest-environment jsdom

import type { AnchorHTMLAttributes, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IssueTree, IssueTreeNode } from "@greatstone/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskTree } from "./TaskTree";

const ME = "user-john";
const navigateMock = vi.fn();
const setBreadcrumbsMock = vi.fn();
let phone = false;
let tree: IssueTree;

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => navigateMock,
  useParams: () => ({ issueId: "GRE-1" }),
  useLocation: () => ({ pathname: "/issues/GRE-1/tree", search: "", hash: "", state: null }),
}));
vi.mock("../hooks/useIsPhone", () => ({ useIsPhone: () => phone }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }) }));
vi.mock("../api/auth", () => ({ authApi: { getSession: async () => ({ user: { id: ME } }) } }));
vi.mock("../api/agents", () => ({
  agentsApi: { list: async () => [{ id: "agent-mica", name: "Mica", appearance: null }] },
}));
vi.mock("../api/access", () => ({
  accessApi: {
    listUserDirectory: async () => ({
      users: [{ principalId: "user-naa", status: "active", user: { name: "Naa Mensah", email: "naa@example.com", image: null } }],
    }),
  },
}));
vi.mock("../api/issues", () => ({ issuesApi: { getTree: async () => tree } }));

// Queries settle on their own between flushes; no act() bookkeeping needed.
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
    updatedAt: new Date("2026-10-20T09:00:00Z"),
    ...values,
  };
}

let container: HTMLDivElement;
let root: Root;

async function flush() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TaskTree />
      </QueryClientProvider>,
    );
  });
  await flush();
}

beforeEach(() => {
  phone = false;
  window.localStorage.clear();
  navigateMock.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // Launch (1): Design done (2) with DNS done (5); Build blocked (3) by Review (4), which waits on John.
  tree = {
    rootId: "1",
    nodes: [
      node("1", null, { title: "Launch the portal", status: "in_progress", childCount: 3, doneChildCount: 1 }),
      node("2", "1", { title: "Design", status: "done", childCount: 1, doneChildCount: 1 }),
      node("3", "1", { title: "Build", status: "blocked", blockedByIds: ["4"], assigneeAgentId: "agent-mica" }),
      node("4", "1", { title: "Sign off the copy", status: "in_review", assigneeUserId: ME }),
      { ...node("5", "2", { title: "DNS", status: "done" }), depth: 2 },
    ],
    externalBlockers: [],
    truncated: false,
    limits: { maxNodes: 300, maxDepth: 12 },
  };
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

describe("Task tree page", () => {
  it("shows the header strip: progress and what is holding the work up, the viewer first", async () => {
    await renderPage();
    const header = container.querySelector('[data-slot="task-tree-header"]')!;
    expect(header.querySelector("h1")?.textContent).toBe("Launch the portal");
    expect(header.textContent).toContain("2 of 4 done");
    const chips = [...header.querySelectorAll("[data-blocker-chip]")];
    expect(chips.map((chip) => chip.getAttribute("data-blocker-chip"))).toEqual(["4"]);
    expect(chips[0]!.textContent).toContain("Sign off the copy");
    expect(chips[0]!.textContent).toContain("Waiting on you");
    expect(chips[0]!.textContent).toContain("Needs a review");
    expect(setBreadcrumbsMock).toHaveBeenLastCalledWith([
      { label: "Tasks", href: "/issues" },
      { label: "GRE-1", href: "/issues/GRE-1?view=task" },
      { label: "Tree" },
    ]);
  });

  it("opens the full task page with ?view=task, so the way out never bounces back to the tree", async () => {
    await renderPage();
    const link = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent === "Open task page");
    expect(link?.getAttribute("href")).toBe("/issues/GRE-1?view=task");
  });

  it("draws the tree on a canvas with the blocked path and the root blocker marked", async () => {
    await renderPage();
    const canvas = container.querySelector('[data-slot="task-tree-canvas"]')!;
    expect(canvas.querySelector('[role="tree"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="task-tree-outline"]')).toBeNull();

    // Finished branches fold into one pill until asked.
    const ids = [...canvas.querySelectorAll("[data-tree-node]")].map((el) => el.getAttribute("data-tree-node"));
    expect(ids).toEqual(["1", "3", "4", "1:done"]);
    expect(canvas.querySelector('[data-tree-node="1:done"]')?.textContent).toContain("+2 done");

    const blocker = canvas.querySelector('[data-tree-node="4"]')!;
    expect(blocker.querySelector("[data-root-blocker]")?.textContent).toContain("Root blocker");
    expect(canvas.querySelector('[data-tree-edge="1>4"]')?.hasAttribute("data-blocked-path")).toBe(true);
    expect(canvas.querySelector('[data-tree-edge="1>3"]')?.hasAttribute("data-blocked-path")).toBe(false);
    // A blocked task names what it waits on.
    expect(canvas.querySelector('[data-tree-node="3"]')?.textContent).toContain("Blocked by GRE-4");

    // Agent owner by name; the viewer's own task reads "You".
    expect(canvas.querySelector('[data-tree-node="3"]')?.textContent).toContain("Mica");
    expect(blocker.textContent).toContain("You");
  });

  it("shows finished work on request and pans to a blocker from its chip", async () => {
    await renderPage();
    flushSync(() => (container.querySelector('[data-tree-node="1:done"]') as HTMLButtonElement).click());
    await flush();
    const ids = [...container.querySelectorAll("[data-tree-node]")].map((el) => el.getAttribute("data-tree-node"));
    expect(ids.sort()).toEqual(["1", "2", "3", "4", "5"]);

    flushSync(() => (container.querySelector('[data-blocker-chip="4"]') as HTMLButtonElement).click());
    await flush();
    expect(document.activeElement?.getAttribute("data-tree-node")).toBe("4");
  });

  it("moves between tasks with the arrow keys and opens one with Enter", async () => {
    await renderPage();
    const rootCard = container.querySelector('[data-tree-node="1"]') as HTMLElement;
    expect(rootCard.tabIndex).toBe(0);
    rootCard.focus();
    flushSync(() => rootCard.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    await flush();
    const focused = document.activeElement as HTMLElement;
    expect(focused.getAttribute("data-tree-node")).toBe("4");
    flushSync(() => focused.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    await flush();
    expect(document.activeElement?.getAttribute("data-tree-node")).toBe("3");
    flushSync(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(navigateMock).toHaveBeenCalledWith("/issues/GRE-3?view=task");
  });

  it("shows an indented outline with the red rail on a phone", async () => {
    phone = true;
    await renderPage();
    expect(container.querySelector('[data-slot="task-tree-canvas"]')).toBeNull();
    const outline = container.querySelector('[data-slot="task-tree-outline"]')!;
    expect(outline).not.toBeNull();
    expect(container.querySelector('[data-slot="task-tree-header"]')?.textContent).toContain("What is holding this up");

    const rows = [...outline.querySelectorAll("[data-outline-node]")];
    expect(rows.map((row) => row.getAttribute("data-outline-node"))).toEqual(["1", "3", "4"]);
    expect(outline.querySelector('[data-outline-node="4"]')?.hasAttribute("data-on-blocked-path")).toBe(true);
    expect(outline.querySelector('[data-outline-node="3"]')?.hasAttribute("data-on-blocked-path")).toBe(false);
    expect(outline.querySelector('[data-outline-node="4"]')?.textContent).toContain("Root blocker");
    expect(outline.querySelector('[data-outline-node="3"] a')?.getAttribute("href")).toBe("/issues/GRE-3?view=task");
    expect(outline.textContent).toContain("+2 done");
  });

  it("says why each blocked task is blocked, down to the root of the chain", async () => {
    // Build (3) waits on Review (4), which waits on Ops outside the tree,
    // which waits on John's card. Tidy (7) is blocked with nothing recorded.
    tree = {
      ...tree,
      nodes: [
        ...tree.nodes.filter((entry) => entry.id !== "3" && entry.id !== "4"),
        node("3", "1", { title: "Build", status: "blocked", blockedByIds: ["4"], rootBlockerId: "ops" }),
        node("4", "1", { title: "Review", status: "blocked", blockedByIds: ["ops"] }),
        node("7", "1", { title: "Tidy", status: "blocked" }),
      ],
      externalBlockers: [
        {
          id: "ops",
          identifier: "GRE-1989",
          title: "Staging upload",
          status: "blocked",
          assigneeAgentId: null,
          assigneeUserId: null,
          waitReason: {
            unblockAction: null,
            unblockOwner: null,
            pendingCard: {
              id: "card-1",
              kind: "request_confirmation",
              title: "approve staging upload",
              addresseeAgentId: null,
              addresseeUserId: "user-naa",
              createdAt: new Date("2026-10-24T10:00:00Z"),
            },
          },
        },
      ],
    };
    await renderPage();
    const build = container.querySelector('[data-tree-node="3"] [data-slot="task-tree-block-line"]')!;
    expect(build.textContent).toBe("Root: GRE-1989, waiting on Naa Mensah: approve staging upload");
    expect(build.getAttribute("href")).toBe("/issues/GRE-1989#interaction-card-1");
    expect(container.querySelector('[data-tree-node="4"] [data-slot="task-tree-block-line"]')?.textContent).toBe("Blocked by GRE-1989");
    const tidy = container.querySelector('[data-tree-node="7"] [data-slot="task-tree-block-reason"]')!;
    expect(tidy.hasAttribute("data-unexplained")).toBe(true);
    expect(tidy.textContent).toBe("Blocked, but nothing recorded is blocking it");

    // On a phone both lines show under the row.
    phone = true;
    await renderPage();
    const lines = [...container.querySelectorAll('[data-outline-node="3"] [data-slot="task-tree-block-line"]')].map((line) => line.textContent);
    expect(lines).toEqual(["Blocked by GRE-4", "Root: GRE-1989, waiting on Naa Mensah: approve staging upload"]);
  });

  it("leads back up to its project tree", async () => {
    tree = { ...tree, project: { id: "project-1", name: "Platform" } };
    await renderPage();
    expect(setBreadcrumbsMock).toHaveBeenLastCalledWith([
      { label: "Projects", href: "/projects" },
      { label: "Platform", href: "/projects/project-1/tree" },
      { label: "GRE-1", href: "/issues/GRE-1?view=task" },
      { label: "Tree" },
    ]);
    const link = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent === "Project tree");
    expect(link?.getAttribute("href")).toBe("/projects/project-1/tree");
  });

  it("says so when the tree was cut short", async () => {
    tree = { ...tree, truncated: true, limits: { maxNodes: 300, maxDepth: 12 } };
    await renderPage();
    expect(container.textContent).toContain("Showing the first 300 tasks, up to 12 levels down.");
  });
});

describe("Task tree navigation", () => {
  const nodeIds = () => [...container.querySelectorAll("[data-tree-node]")].map((el) => el.getAttribute("data-tree-node"));
  const clickButton = async (label: string) => {
    const button = [...container.querySelectorAll("button")].find((el) => el.textContent?.trim() === label || el.getAttribute("aria-label") === label);
    if (!button) throw new Error(`No button "${label}"`);
    flushSync(() => (button as HTMLButtonElement).click());
    await flush();
  };

  beforeEach(() => {
    tree = { ...tree, nodes: [...tree.nodes, { ...node("6", "3", { title: "Wire the payments API" }), depth: 2 }] };
  });

  it("collapses and expands every branch, and remembers the fold", async () => {
    await renderPage();
    expect(nodeIds()).toContain("6");
    await clickButton("Collapse all");
    expect(nodeIds()).not.toContain("6");
    expect(JSON.parse(window.localStorage.getItem("gsam.diagram.task-tree.GRE-1")!).collapsed).toContain("3");
    await clickButton("Expand all");
    expect(nodeIds()).toContain("6");
  });

  it("finds a task by name: unfolds its branch, focuses it and highlights it", async () => {
    await renderPage();
    await clickButton("Collapse all");
    const input = container.querySelector("[data-diagram-find]") as HTMLInputElement;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "payments");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect([...container.querySelectorAll('[role="option"]')].map((el) => el.textContent)).toEqual(["Wire the payments APIGRE-6"]);
    flushSync(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await flush();
    const found = container.querySelector('[data-tree-node="6"]')!;
    expect(found.hasAttribute("data-found")).toBe(true);
    expect(document.activeElement).toBe(found);
  });

  it("zooms with + and - from a task and keeps the controls in the toolbar", async () => {
    await renderPage();
    const zoom = () => container.querySelector("[data-diagram-zoom]")?.textContent;
    const rootCard = container.querySelector('[data-tree-node="1"]') as HTMLElement;
    flushSync(() => rootCard.dispatchEvent(new KeyboardEvent("keydown", { key: "+", bubbles: true })));
    expect(zoom()).toBe("120%");
    flushSync(() => rootCard.dispatchEvent(new KeyboardEvent("keydown", { key: "-", bubbles: true })));
    expect(zoom()).toBe("100%");
    const toolbar = container.querySelector('[role="toolbar"][aria-label="Task tree controls"]')!;
    for (const label of ["Fit to screen", "Reset", "Full screen", "Collapse all", "Expand all"]) {
      expect([...toolbar.querySelectorAll("button")].some((el) => el.textContent?.trim() === label)).toBe(true);
    }
  });

  it("opens the diagram full screen from the outline on a phone, and goes back to the outline", async () => {
    phone = true;
    await renderPage();
    expect(container.querySelector('[data-slot="task-tree-canvas"]')).toBeNull();
    await clickButton("Open the diagram full screen");
    expect(container.querySelector('[data-slot="task-tree-canvas"]')).not.toBeNull();
    expect(container.querySelector("[data-diagram-frame]")?.getAttribute("data-fullscreen")).toBe("overlay");
    await clickButton("Exit full screen");
    expect(container.querySelector('[data-slot="task-tree-canvas"]')).toBeNull();
    expect(container.querySelector('[data-slot="task-tree-outline"]')).not.toBeNull();
  });
});
