import { describe, expect, it } from "vitest";
import {
  buildBlockedWorkOverview,
  type BlockedWorkEdge,
  type BlockedWorkIssueRow,
} from "../services/blocked-work.ts";

const NOW = new Date("2026-10-16T08:00:00.000Z");

function row(id: string, overrides: Partial<BlockedWorkIssueRow> = {}): BlockedWorkIssueRow {
  return {
    id,
    identifier: id.toUpperCase(),
    title: `Task ${id}`,
    status: "blocked",
    assigneeAgentId: null,
    assigneeUserId: null,
    unblockDescriptor: null,
    blockedTransitionAt: null,
    updatedAt: new Date("2026-10-15T08:00:00.000Z"),
    ...overrides,
  };
}

function build(rows: BlockedWorkIssueRow[], edges: BlockedWorkEdge[]) {
  return buildBlockedWorkOverview({
    blocked: rows.filter((r) => r.status === "blocked"),
    issuesById: new Map(rows.map((r) => [r.id, r])),
    edges,
    now: NOW,
  });
}

describe("buildBlockedWorkOverview", () => {
  it("groups a chain under the single open task that holds it", () => {
    // root (in progress, Mason) <- a <- b, and root <- c
    const overview = build(
      [
        row("root", { status: "in_progress", assigneeAgentId: "mason" }),
        row("a", { blockedTransitionAt: new Date("2026-10-10T08:00:00.000Z") }),
        row("b"),
        row("c"),
      ],
      [
        { blockerId: "root", blockedId: "a" },
        { blockerId: "a", blockedId: "b" },
        { blockerId: "root", blockedId: "c" },
      ],
    );

    expect(overview.totalBlocked).toBe(3);
    expect(overview.rootCauses).toHaveLength(1);
    const [root] = overview.rootCauses;
    expect(root!.issue.id).toBe("root");
    expect(root!.owner).toEqual({ type: "agent", agentId: "mason", userId: null });
    expect(root!.heldIssueIds).toEqual(["a", "b", "c"]);
    expect(root!.oldestWaitingSince).toBe("2026-10-10T08:00:00.000Z");
    expect(overview.items.find((item) => item.issue.id === "b")!.rootIssueIds).toEqual(["root"]);
    expect(overview.oldestWaitingSince).toBe("2026-10-10T08:00:00.000Z");
    // Longest waiting first.
    expect(overview.items[0]!.issue.id).toBe("a");
  });

  it("uses the named unblock owner of a blocked root, not its assignee", () => {
    const overview = build(
      [
        row("head", {
          assigneeAgentId: "everest",
          unblockDescriptor: { owner: "board", action: "Grant the Netlify token" },
        }),
        row("tail", { assigneeAgentId: "ridge" }),
      ],
      [{ blockerId: "head", blockedId: "tail" }],
    );

    expect(overview.rootCauses[0]!.owner.type).toBe("board");
    expect(overview.rootCauses[0]!.action).toBe("Grant the Netlify token");
    expect(overview.items.find((item) => item.issue.id === "tail")!.owner).toEqual({
      type: "agent",
      agentId: "ridge",
      userId: null,
    });
  });

  it("flags blocked tasks whose blockers are all finished or cancelled", () => {
    const overview = build(
      [
        row("done-blocker", { status: "done" }),
        row("cancelled-blocker", { status: "cancelled" }),
        row("ready"),
        row("orphaned"),
      ],
      [
        { blockerId: "done-blocker", blockedId: "ready" },
        { blockerId: "cancelled-blocker", blockedId: "orphaned" },
      ],
    );

    const byId = new Map(overview.items.map((item) => [item.issue.id, item]));
    expect(byId.get("ready")!.tidyReason).toBe("waiting_on_finished_work");
    expect(byId.get("orphaned")!.tidyReason).toBe("waiting_on_cancelled_work");
    expect(byId.get("ready")!.rootIssueIds).toEqual(["ready"]);
    expect(overview.rootCauses).toEqual([]);
  });

  it("does not flag a task that still has one open blocker", () => {
    const overview = build(
      [row("done-blocker", { status: "done" }), row("open-blocker", { status: "todo" }), row("waiting")],
      [
        { blockerId: "done-blocker", blockedId: "waiting" },
        { blockerId: "open-blocker", blockedId: "waiting" },
      ],
    );

    expect(overview.items[0]!.tidyReason).toBeNull();
    expect(overview.items[0]!.rootIssueIds).toEqual(["open-blocker"]);
    expect(overview.rootCauses[0]!.owner.type).toBe("nobody");
  });

  it("survives a blocker cycle", () => {
    const overview = build(
      [row("x"), row("y"), row("z")],
      [
        { blockerId: "x", blockedId: "y" },
        { blockerId: "y", blockedId: "x" },
        { blockerId: "y", blockedId: "z" },
      ],
    );

    expect(overview.totalBlocked).toBe(3);
    expect(overview.rootCauses.length).toBeGreaterThan(0);
    for (const item of overview.items) expect(item.rootIssueIds.length).toBeGreaterThan(0);
  });

  it("returns an empty overview when nothing is blocked", () => {
    const overview = build([row("busy", { status: "in_progress" })], []);
    expect(overview).toMatchObject({ totalBlocked: 0, oldestWaitingSince: null, rootCauses: [], items: [] });
  });
});
