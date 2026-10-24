import type { IssueTree, IssueTreeExternalBlocker, IssueTreeNode } from "@greatstone/shared";
import { describe, expect, it } from "vitest";
import { indexTaskTree } from "./task-tree";
import { describeTreeBlock, treeNameOf, UNEXPLAINED_BLOCK_TEXT } from "./task-tree-block-reason";

function node(id: string, values: Partial<IssueTreeNode> = {}): IssueTreeNode {
  return {
    id,
    identifier: `GRE-${id}`,
    title: `Task ${id}`,
    status: "blocked",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    parentId: id === "1" ? null : "1",
    depth: id === "1" ? 0 : 1,
    blockedByIds: [],
    childCount: 0,
    doneChildCount: 0,
    terminalBlockerId: null,
    unblockAction: null,
    updatedAt: new Date("2026-10-24T09:00:00Z"),
    ...values,
  };
}

const nameOf = treeNameOf({
  agents: new Map([["agent-lintel", { name: "Lintel" }]]),
  users: new Map([
    ["user-john", { label: "John" }],
    ["user-ben", { label: "Ben" }],
  ]),
  viewerUserId: "user-ben",
});

function reasonFor(nodes: IssueTreeNode[], id: string, externalBlockers: IssueTreeExternalBlocker[] = []) {
  const tree: IssueTree = { rootId: "1", nodes, externalBlockers, truncated: false, limits: { maxNodes: 300, maxDepth: 12 } };
  const index = indexTaskTree(tree)!;
  return describeTreeBlock(index.byId.get(id)!, index, nameOf);
}

const card = (values: Partial<NonNullable<IssueTreeNode["pendingCard"]>> = {}) => ({
  id: "card-1",
  kind: "request_confirmation",
  title: "Approve staging upload",
  addresseeAgentId: null,
  addresseeUserId: "user-john",
  createdAt: new Date("2026-10-24T10:00:00Z"),
  ...values,
});

describe("describeTreeBlock", () => {
  it("says nothing for a task that is not blocked", () => {
    expect(reasonFor([node("1", { status: "in_progress" })], "1")).toBeNull();
  });

  it("names the open blocker first, with a count of the rest, and links to it", () => {
    const reason = reasonFor(
      [node("1", { status: "todo" }), node("2", { blockedByIds: ["3", "4", "5"] }), node("3", { status: "done" }), node("4", { status: "todo" }), node("5", { status: "in_progress" })],
      "2",
    );
    expect(reason).toEqual({ own: { text: "Blocked by GRE-4 +1", href: "/issues/GRE-4" }, root: null, unexplained: false });
  });

  it("names the person a pending card waits on and links to the card", () => {
    expect(reasonFor([node("1", { pendingCard: card() })], "1")?.own).toEqual({
      text: "Waiting on John: Approve staging upload",
      href: "/issues/GRE-1#interaction-card-1",
    });
    expect(reasonFor([node("1", { pendingCard: card({ addresseeUserId: null, title: null }) })], "1")?.own.text).toBe(
      "Waiting for a reply: a reply",
    );
  });

  it("uses the owner's note when there is no card", () => {
    expect(
      reasonFor([node("1", { unblockAction: "OneDrive details", unblockOwner: { userId: "user-ben" } })], "1")?.own.text,
    ).toBe("Waiting on you: OneDrive details");
    expect(reasonFor([node("1", { unblockAction: "Budget sign-off", unblockOwner: "board" })], "1")?.own.text).toBe(
      "Waiting on the board: Budget sign-off",
    );
    expect(reasonFor([node("1", { unblockAction: "Turnstile keys" })], "1")?.own.text).toBe("Needs: Turnstile keys");
  });

  it("warns when a blocked task has no open blocker, card or note", () => {
    const reason = reasonFor([node("1", { status: "todo" }), node("2", { blockedByIds: ["3"] }), node("3", { status: "done" })], "2");
    expect(reason).toEqual({ own: { text: UNEXPLAINED_BLOCK_TEXT, href: null }, root: null, unexplained: true });
  });

  it("adds the root of the chain with what it waits on", () => {
    const nodes = [
      node("1", { blockedByIds: ["2"], rootBlockerId: "3" }),
      node("2", { blockedByIds: ["3"] }),
      node("3", { unblockAction: "Resume after the upload", unblockOwner: { agentId: "agent-lintel" } }),
    ];
    expect(reasonFor(nodes, "1")?.root).toEqual({
      text: "Root: GRE-3, waiting on Lintel: Resume after the upload",
      href: "/issues/GRE-3",
    });
    // A root blocker with nothing recorded says so.
    nodes[2] = node("3");
    expect(reasonFor(nodes, "1")?.root?.text).toBe("Root: GRE-3, nothing recorded");
    // A root that is simply not started yet is just named.
    nodes[2] = node("3", { status: "todo" });
    expect(reasonFor(nodes, "1")?.root?.text).toBe("Root: GRE-3");
  });

  it("reads the root's card from a blocker outside the tree", () => {
    const outside: IssueTreeExternalBlocker = {
      id: "x",
      identifier: "GRE-1989",
      title: "Staging upload",
      status: "blocked",
      assigneeAgentId: null,
      assigneeUserId: null,
      waitReason: { unblockAction: null, unblockOwner: null, pendingCard: card() },
    };
    const reason = reasonFor([node("1", { blockedByIds: ["2"], rootBlockerId: "x" }), node("2", { blockedByIds: ["x"] })], "1", [outside]);
    expect(reason?.root).toEqual({
      text: "Root: GRE-1989, waiting on John: Approve staging upload",
      href: "/issues/GRE-1989#interaction-card-1",
    });
  });

  it("leaves the root out when it is the direct blocker", () => {
    const reason = reasonFor([node("1", { blockedByIds: ["2"], rootBlockerId: "2" }), node("2", { status: "todo" })], "1");
    expect(reason?.root).toBeNull();
  });
});
