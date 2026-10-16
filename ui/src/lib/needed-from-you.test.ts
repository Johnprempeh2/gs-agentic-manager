import { describe, expect, it } from "vitest";
import type { DecisionCard } from "@greatstone/shared";
import type { PipelineAttentionFeed } from "@/api/pipelines";
import { buildNeededFromYou, neededLaterKey, neededListText, neededSummary, waitedFor, withoutPutAway, type NeededGroup, type NeededGroupId } from "./needed-from-you";

function card(id: string, kind: DecisionCard["kind"], extra: Partial<DecisionCard> = {}): DecisionCard {
  return {
    id,
    kind,
    kinds: [kind],
    task: { kind: "issue", id: `issue-${id}`, companyId: "c", title: "T", identifier: `GRE-${id}`, status: "blocked", href: null },
    title: `Card ${id}`,
    reason: `Reason ${id}`,
    waiting: { id: "a1", name: "Everest" },
    nextStep: "",
    severity: "medium",
    activityAt: "2026-10-15T10:00:00.000Z",
    createdAt: "2026-10-15T10:00:00.000Z",
    actions: [],
    clarity: null,
    items: [],
    ...extra,
  } as DecisionCard;
}

const task = (id: string) => ({ id, identifier: `GRE-${id}`, title: `Task ${id}`, status: "todo", priority: "medium", updatedAt: "2026-10-14T10:00:00.000Z" });

describe("buildNeededFromYou", () => {
  it("groups decision cards by what the person has to do, in a fixed order", () => {
    const groups = buildNeededFromYou({
      cards: [card("1", "blocked"), card("2", "question"), card("3", "approval"), card("4", "connection"), card("5", "question", { atDesk: { command: null } })],
      needsMe: null,
      clients: null,
    });
    expect(groups.map((group) => [group.id, group.items.map((item) => item.id)])).toEqual([
      ["answer", ["2"]],
      ["sign-off", ["3"]],
      ["unblock", ["1"]],
      ["fix", ["4", "5"]],
    ]);
    expect(groups[0].items[0]).toMatchObject({ title: "Card 2", reason: "Reason 2", waiting: "Everest", href: "/issues/GRE-2" });
  });

  it("shows each task once: a card beats an overdue wait, which beats a plain assigned task", () => {
    const groups = buildNeededFromYou({
      cards: [card("1", "question")],
      needsMe: {
        overdueWaits: [
          { ...task("issue-1"), assigneeAgentId: null, owner: "user", action: "Reply", waitingSinceAt: "2026-10-13T00:00:00.000Z", waitingForMs: 1, recheckWokenAt: null },
          { ...task("w2"), assigneeAgentId: null, owner: "user", action: "Upload the brief", waitingSinceAt: "2026-10-13T00:00:00.000Z", waitingForMs: 1, recheckWokenAt: null },
        ],
        assignedTasks: [task("w2"), task("t3")],
      },
      clients: null,
    });
    expect(groups.map((group) => [group.id, group.items.map((item) => item.id)])).toEqual([
      ["answer", ["1"]],
      ["overdue", ["wait:w2"]],
      ["tasks", ["task:t3"]],
    ]);
    expect(groups[1].items[0].reason).toBe("Upload the brief");
  });

  it("adds client cases waiting for review or a stage move", () => {
    const ref = {
      id: "case-1", caseKey: null, title: "Acme", version: 1, updatedAt: "2026-10-15T00:00:00.000Z", createdAt: "2026-10-01T00:00:00.000Z",
      pipeline: { id: "p1", key: "clients", name: "Clients" }, stage: { id: "s1", key: "proposal", name: "Proposal", kind: "work" },
    };
    const clients = {
      reviews: [{ case: ref, review: {} }],
      suggestions: [{ case: { ...ref, id: "case-2", title: "Beta" }, suggestion: { id: "sg1", fromStageKey: "a", fromStageName: "A", toStageKey: "b", toStageName: "Won", rationale: "", createdAt: "2026-10-15T00:00:00.000Z", suggestedBy: { agentId: "x", agentName: "Sales" } } }],
      headsUp: [],
      counts: { suggestions: 1, reviews: 1, headsUp: 0 },
    } as unknown as PipelineAttentionFeed;
    const [group] = buildNeededFromYou({ cards: [], needsMe: null, clients });
    expect(group.id).toBe("clients");
    expect(group.items.map((item) => [item.title, item.reason, item.href])).toEqual([
      ["Acme", "Ready for your review in Proposal", "/pipelines/p1/items/case-1"],
      ["Beta", "Sales suggests moving it to Won", "/pipelines/p1/items/case-2"],
    ]);
  });

  it("leaves out a reason that only repeats the title", () => {
    const [group] = buildNeededFromYou({ cards: [card("1", "question", { reason: "Card 1" })], needsMe: null, clients: null });
    expect(group.items[0].reason).toBeNull();
  });
});

describe("neededSummary", () => {
  const now = new Date("2026-10-15T12:00:00.000Z").getTime();
  it("says all clear when nothing waits", () => {
    expect(neededSummary([], now)).toContain("Nothing needs you right now");
  });
  it("counts the things and names the oldest wait", () => {
    const groups = buildNeededFromYou({ cards: [card("1", "question"), card("2", "approval", { createdAt: "2026-10-13T12:00:00.000Z" })], needsMe: null, clients: null });
    expect(neededSummary(groups, now)).toBe("2 things need you. The oldest has waited 2 days.");
  });
  it("puts waits in plain words", () => {
    expect(waitedFor(30_000)).toBe("a minute");
    expect(waitedFor(90 * 60_000)).toBe("2 hours");
    expect(waitedFor(25 * 3_600_000)).toBe("a day");
  });
});

describe("withoutPutAway", () => {
  const group = (id: NeededGroupId, ids: string[]): NeededGroup => ({
    id, title: id, explain: "", allHref: "/", allLabel: "All",
    items: ids.map((itemId) => ({ id: itemId, title: itemId, reason: null, waiting: null, since: null, href: "/" })),
  });
  const now = Date.parse("2026-10-16T04:00:00Z");

  it("drops rows still snoozed and groups left empty", () => {
    const result = withoutPutAway(
      [group("answer", ["a", "b"]), group("tasks", ["task:t1"])],
      [
        { kind: "snooze", itemKey: neededLaterKey("a"), snoozedUntil: "2026-10-17T08:00:00Z" },
        { kind: "snooze", itemKey: neededLaterKey("task:t1"), snoozedUntil: "2026-10-17T08:00:00Z" },
        { kind: "snooze", itemKey: neededLaterKey("b"), snoozedUntil: "2026-10-16T03:00:00Z" },
        { kind: "dismiss", itemKey: neededLaterKey("b"), snoozedUntil: null },
      ],
      now,
    );
    expect(result.map((g) => [g.id, g.items.map((i) => i.id)])).toEqual([["answer", ["b"]]]);
  });
});

describe("neededListText", () => {
  it("groups each row with who waits, how long and a link", () => {
    const now = new Date(2026, 9, 16, 12).getTime();
    const groups = [
      {
        id: "answer",
        title: "Answer a question",
        explain: "",
        allHref: "/decisions",
        allLabel: "",
        items: [
          { id: "1", title: "Which supplier?", reason: "Two quotes in", waiting: "Ridge", since: new Date(now - 2 * 86_400_000).toISOString(), href: "/decisions/1" },
          { id: "2", title: "Logo sign-off", reason: null, waiting: null, since: null, href: "/decisions/2" },
        ],
      },
    ] as NeededGroup[];
    const lines = neededListText(groups, (href) => `https://gsam.test${href}`, now).split("\n");
    expect(lines[0]).toBe("What needs me, 16 Oct");
    expect(lines[1]).toBe("2 things need you. The oldest has waited 2 days.");
    expect(lines[3]).toBe("Answer a question");
    expect(lines[4]).toBe("• Which supplier?: Two quotes in (Ridge, waiting 2 days) https://gsam.test/decisions/1");
    expect(lines[5]).toBe("• Logo sign-off https://gsam.test/decisions/2");
  });
});
