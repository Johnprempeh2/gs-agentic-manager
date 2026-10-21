import { useMemo, useState } from "react";
import type { IssueTreeNode } from "@greatstone/shared";
import { indexTaskTree, traceBlockedPaths, visibleTaskTree } from "@/lib/task-tree";
import { ProgressRing } from "./ProgressRing";
import { TaskTreeCanvas } from "./TaskTreeCanvas";
import { TASK_TREE_CARD_HEIGHT, TASK_TREE_CARD_WIDTH, TaskTreeCard } from "./TaskTreeCard";
import { countTreeStatuses, TaskTreeHeader } from "./TaskTreeHeader";
import { TaskTreeOutline } from "./TaskTreeOutline";
import type { TaskTreePeople } from "./TaskTreeOwner";

const updatedAt = new Date("2026-10-20T09:00:00Z");

function sample(id: string, parentId: string | null, values: Partial<IssueTreeNode>): IssueTreeNode {
  return {
    id,
    identifier: `GRE-${id}`,
    title: `Task ${id}`,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    parentId,
    depth: 0,
    blockedByIds: [],
    childCount: 0,
    doneChildCount: 0,
    terminalBlockerId: null,
    unblockAction: null,
    updatedAt,
    ...values,
  };
}

const SAMPLE_TREE = {
  rootId: "100",
  nodes: [
    sample("100", null, { title: "Launch the client portal", status: "in_progress", childCount: 4, doneChildCount: 1, assigneeAgentId: "agent-ridge" }),
    sample("101", "100", { title: "Brand and copy", status: "done", childCount: 2, doneChildCount: 2, assigneeAgentId: "agent-mica" }),
    sample("102", "101", { title: "Write the homepage copy", status: "done", assigneeAgentId: "agent-mica" }),
    sample("103", "101", { title: "Pick the photography", status: "done", assigneeUserId: "user-naa" }),
    sample("104", "100", { title: "Build the sign-in flow", status: "blocked", blockedByIds: ["107"], assigneeAgentId: "agent-ridge", priority: "high", childCount: 2, doneChildCount: 1 }),
    sample("105", "104", { title: "Password reset emails", status: "done", assigneeAgentId: "agent-ridge" }),
    sample("106", "104", { title: "Single sign-on for staff", status: "in_progress", assigneeAgentId: "agent-ridge" }),
    sample("107", "100", { title: "Approve the hosting budget", status: "blocked", unblockAction: "Approve the budget", assigneeUserId: "user-john", priority: "critical" }),
    sample("108", "100", { title: "Load test before go-live", status: "todo" }),
  ],
  externalBlockers: [],
  truncated: false,
  limits: { maxNodes: 300, maxDepth: 12 },
};

const PEOPLE: TaskTreePeople = {
  agents: new Map([
    ["agent-ridge", { id: "agent-ridge", name: "Ridge", appearance: null }],
    ["agent-mica", { id: "agent-mica", name: "Mica", appearance: null }],
  ]),
  users: new Map([
    ["user-naa", { label: "Naa Mensah", image: null }],
    ["user-john", { label: "John Prempeh", image: null }],
  ]),
  viewerUserId: "user-john",
};

/** Design guide: the task tree's parts, with sample data. */
export function TaskTreeDesignExamples() {
  const index = useMemo(() => indexTaskTree(SAMPLE_TREE)!, []);
  const trace = useMemo(() => traceBlockedPaths(index, PEOPLE.viewerUserId), [index]);
  const [showFinished, setShowFinished] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const visibleRoot = useMemo(() => visibleTaskTree(index, { showFinished, collapsed }), [index, showFinished, collapsed]);
  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const node = (id: string) => index.byId.get(id)!;
  const cardStyle = { width: TASK_TREE_CARD_WIDTH, height: TASK_TREE_CARD_HEIGHT };

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <h4 className="text-sm font-medium">ProgressRing</h4>
        <div className="flex flex-wrap items-center gap-6">
          <ProgressRing done={0} total={4} />
          <ProgressRing done={5} total={7} />
          <ProgressRing done={7} total={7} />
          <ProgressRing done={3} total={4} size={28} showLabel={false} />
        </div>
      </div>

      <div className="space-y-3">
        <h4 className="text-sm font-medium">TaskTreeCard</h4>
        <div className="flex flex-wrap gap-6 pb-4">
          <div style={cardStyle}>
            <TaskTreeCard node={node("100")} people={PEOPLE} isRoot descendants={8} onToggleCollapsed={() => {}} />
          </div>
          <div style={cardStyle}>
            <TaskTreeCard node={node("104")} people={PEOPLE} onBlockedPath descendants={2} collapsed onToggleCollapsed={() => {}} />
          </div>
          <div style={cardStyle}>
            <TaskTreeCard node={node("107")} people={PEOPLE} onBlockedPath isRootBlocker />
          </div>
          <div style={cardStyle}>
            <TaskTreeCard node={node("106")} people={PEOPLE} waitingOn="OPS-14" />
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <h4 className="text-sm font-medium">TaskTreeHeader</h4>
        <TaskTreeHeader
          root={index.root}
          counts={countTreeStatuses(index.byId.values(), index.root.id)}
          rootBlockers={trace.rootBlockers}
          people={PEOPLE}
        />
      </div>

      <div className="space-y-3">
        <h4 className="text-sm font-medium">TaskTreeCanvas (drag, wheel, arrow keys; the red path flows to the root blocker)</h4>
        <TaskTreeCanvas
          className="h-120"
          visibleRoot={visibleRoot}
          trace={trace}
          people={PEOPLE}
          onOpen={() => {}}
          onToggleCollapsed={toggle}
          onShowFinished={() => setShowFinished(true)}
        />
      </div>

      <div className="space-y-3">
        <h4 className="text-sm font-medium">TaskTreeOutline (phone)</h4>
        <div className="max-w-sm rounded-xl border border-border bg-card p-2">
          <TaskTreeOutline
            visibleRoot={visibleRoot}
            trace={trace}
            people={PEOPLE}
            hrefFor={(item) => `/issues/${item.node.identifier}`}
            onToggleCollapsed={toggle}
            onShowFinished={() => setShowFinished(true)}
          />
        </div>
      </div>
    </div>
  );
}
