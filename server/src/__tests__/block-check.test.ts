import { describe, expect, it } from "vitest";
import {
  buildBlockCheck,
  titleCondition,
  type BlockCheckBlockerRow,
  type BlockCheckCardRow,
  type BlockCheckTaskRow,
} from "../services/block-check.js";

const now = new Date("2026-10-24T18:00:00.000Z");
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 60 * 60 * 1000);

function task(overrides: Partial<BlockCheckTaskRow> & { id: string }): BlockCheckTaskRow {
  return {
    identifier: overrides.id.toUpperCase(),
    title: `Task ${overrides.id}`,
    status: "blocked",
    projectId: "web",
    assigneeAgentId: "lintel",
    assigneeUserId: null,
    unblockDescriptor: null,
    blockedTransitionAt: hoursAgo(2),
    updatedAt: hoursAgo(2),
    ...overrides,
  };
}

function card(overrides: Partial<BlockCheckCardRow> & { id: string; issueId: string }): BlockCheckCardRow {
  return {
    status: "pending",
    title: "Approve staging upload",
    summary: null,
    addresseeAgentId: null,
    addresseeUserId: "john",
    createdAt: hoursAgo(1),
    resolvedAt: null,
    ...overrides,
  };
}

function check(input: {
  tasks: BlockCheckTaskRow[];
  blockers?: BlockCheckBlockerRow[];
  edges?: { blockerId: string; blockedId: string }[];
  cards?: BlockCheckCardRow[];
}) {
  return buildBlockCheck({
    tasks: input.tasks,
    blockersById: new Map((input.blockers ?? []).map((row) => [row.id, row])),
    edges: input.edges ?? [],
    cards: input.cards ?? [],
    projectsById: new Map([["web", { id: "web", name: "Website", leadAgentId: "lintel" }]]),
    now,
  });
}

function kinds(result: ReturnType<typeof check>) {
  return result.projects.flatMap((project) => project.items.map((item) => `${item.kind}:${item.issue.id}`));
}

describe("block check", () => {
  it("flags a blocked task with no open blocker, no pending card and no recorded reason", () => {
    const result = check({ tasks: [task({ id: "a" })] });
    expect(kinds(result)).toEqual(["unexplained:a"]);
    expect(result.projects[0]).toMatchObject({ projectId: "web", projectName: "Website", leadAgentId: "lintel" });
  });

  it("leaves a block alone when an open blocker, a pending card or a reason explains it", () => {
    const result = check({
      tasks: [
        task({ id: "by-task" }),
        task({ id: "by-card" }),
        task({ id: "by-note", unblockDescriptor: { owner: { agentId: "mason" }, action: "Ship the API" } }),
      ],
      blockers: [{ id: "open", status: "in_progress", hiddenAt: null }],
      edges: [{ blockerId: "open", blockedId: "by-task" }],
      cards: [card({ id: "c1", issueId: "by-card" })],
    });
    expect(result.projects).toEqual([]);
    expect(result.totalItems).toBe(0);
  });

  it("does not count a hidden blocker, as the tree does not", () => {
    const result = check({
      tasks: [task({ id: "a" })],
      blockers: [{ id: "gone", status: "todo", hiddenAt: hoursAgo(1) }],
      edges: [{ blockerId: "gone", blockedId: "a" }],
    });
    expect(kinds(result)).toEqual(["unexplained:a"]);
  });

  it("flags a blocked task whose blockers are all closed", () => {
    const result = check({
      tasks: [task({ id: "a", unblockDescriptor: { owner: "board", action: "Wait for B" } })],
      blockers: [
        { id: "b", status: "done", hiddenAt: null },
        { id: "c", status: "cancelled", hiddenAt: null },
      ],
      edges: [
        { blockerId: "b", blockedId: "a" },
        { blockerId: "c", blockedId: "a" },
      ],
    });
    expect(kinds(result)).toEqual(["blockers_closed:a"]);
    expect(result.projects[0]!.items[0]!.blockerIds).toEqual(["b", "c"]);
  });

  it("flags a blocked task whose card was answered after it was blocked (GRE-1989)", () => {
    const result = check({
      tasks: [
        task({
          id: "gre-1989",
          blockedTransitionAt: hoursAgo(3),
          unblockDescriptor: { owner: { userId: "john" }, action: "Resume after John accepts the staging upload card" },
        }),
      ],
      cards: [card({ id: "upload", issueId: "gre-1989", status: "accepted", resolvedAt: hoursAgo(2) })],
    });
    expect(kinds(result)).toEqual(["card_answered:gre-1989"]);
    expect(result.projects[0]!.items[0]).toMatchObject({ cardId: "upload", since: hoursAgo(2).toISOString() });
  });

  it("ignores a card answered before the task was blocked", () => {
    const result = check({
      tasks: [task({ id: "a", blockedTransitionAt: hoursAgo(1) })],
      cards: [card({ id: "old", issueId: "a", status: "accepted", resolvedAt: hoursAgo(5) })],
    });
    expect(kinds(result)).toEqual(["unexplained:a"]);
  });

  it("flags titles that name a condition, on any open task", () => {
    expect(titleCondition("Publish the site (after John accepts the proof)")).toBe("after John accepts the proof");
    expect(titleCondition("Send keys [once Ben replies]")).toBe("once Ben replies");
    expect(titleCondition("Fix the (afternoon) banner")).toBeNull();
    expect(titleCondition("Plain title")).toBeNull();

    const result = check({
      tasks: [
        task({ id: "a", status: "todo", title: "Publish the site (after John accepts the proof)" }),
        task({ id: "b", status: "done", title: "Old (after launch)" }),
      ],
    });
    expect(kinds(result)).toEqual(["condition_in_title:a"]);
    expect(result.projects[0]!.items[0]!.detail).toContain("after John accepts the proof");
  });

  it("flags a card to a person older than a day, but not one to an agent or a newer one", () => {
    const result = check({
      tasks: [task({ id: "a", status: "in_progress" })],
      cards: [
        card({ id: "old-john", issueId: "a", createdAt: hoursAgo(30) }),
        card({ id: "old-board", issueId: "a", addresseeUserId: null, createdAt: hoursAgo(26) }),
        card({ id: "old-agent", issueId: "a", addresseeUserId: null, addresseeAgentId: "everest", createdAt: hoursAgo(30) }),
        card({ id: "new-john", issueId: "a", createdAt: hoursAgo(2) }),
      ],
    });
    const items = result.projects[0]!.items;
    expect(items.map((item) => [item.kind, item.cardId, item.waitingOn])).toEqual([
      ["old_human_ask", "old-john", { userId: "john" }],
      ["old_human_ask", "old-board", "board"],
    ]);
  });

  it("flags a recorded ask to a person once the task has been blocked over a day", () => {
    const ask = { owner: { userId: "ben" }, action: "Send the OneDrive details" } as const;
    const result = check({
      tasks: [
        task({ id: "old", unblockDescriptor: ask, blockedTransitionAt: hoursAgo(30) }),
        task({ id: "new", unblockDescriptor: ask, blockedTransitionAt: hoursAgo(3) }),
        task({ id: "agent", unblockDescriptor: { owner: { agentId: "mason" }, action: "Build it" }, blockedTransitionAt: hoursAgo(30) }),
      ],
    });
    expect(kinds(result)).toEqual(["old_human_ask:old"]);
    expect(result.projects[0]!.items[0]!.waitingOn).toEqual({ userId: "ben" });
  });

  it("groups by project and keeps the fingerprint until the items change", () => {
    const first = check({ tasks: [task({ id: "a" }), task({ id: "b", projectId: null })] });
    expect(first.projects.map((project) => project.projectId).sort()).toEqual([null, "web"].sort());
    const again = check({ tasks: [task({ id: "a", updatedAt: hoursAgo(1) }), task({ id: "b", projectId: null })] });
    const changed = check({ tasks: [task({ id: "a" }), task({ id: "c" }), task({ id: "b", projectId: null })] });
    const web = (result: ReturnType<typeof check>) => result.projects.find((project) => project.projectId === "web")!;
    expect(web(again).fingerprint).toBe(web(first).fingerprint);
    expect(web(changed).fingerprint).not.toBe(web(first).fingerprint);
  });
});
