import { describe, expect, it } from "vitest";
import type { DecisionCard } from "@greatstone/shared";
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
  it("groups decision cards by what the person has to do, in a fixed order, leaving At your desk out", () => {
    const groups = buildNeededFromYou({
      cards: [card("1", "blocked"), card("2", "question"), card("3", "approval"), card("4", "connection"), card("5", "question", { atDesk: { command: null } })],
      needsMe: null,
    });
    expect(groups.map((group) => [group.id, group.items.map((item) => item.id)])).toEqual([
      ["answer", ["2"]],
      ["sign-off", ["3"]],
      ["unblock", ["1"]],
      ["fix", ["4"]],
    ]);
    expect(groups[0].items[0]).toMatchObject({ title: "Card 2", reason: "Reason 2", waiting: "Everest", href: "/issues/GRE-2" });
  });

  it("lists exactly the one count's items: a card beats an overdue wait; expired questions too; never assigned tasks", () => {
    const groups = buildNeededFromYou({
      cards: [card("1", "question")],
      needsMe: {
        overdueWaits: [
          { ...task("issue-1"), assigneeAgentId: null, owner: "user", action: "Reply", waitingSinceAt: "2026-10-13T00:00:00.000Z", waitingForMs: 1, recheckWokenAt: null },
          { ...task("w2"), assigneeAgentId: null, owner: "user", action: "Upload the brief", waitingSinceAt: "2026-10-13T00:00:00.000Z", waitingForMs: 1, recheckWokenAt: null },
        ],
        expiredCards: [
          { interactionId: "q9", id: "e9", identifier: "GRE-e9", title: "Book interviews", question: "Which week?", expiredAt: "2026-10-14T00:00:00.000Z" },
        ],
      },
    });
    expect(groups.map((group) => [group.id, group.items.map((item) => item.id)])).toEqual([
      ["answer", ["1"]],
      ["overdue", ["wait:w2", "expired:q9"]],
    ]);
    expect(groups[1].items[0].reason).toBe("Upload the brief");
    expect(groups[1].items[1]).toMatchObject({ reason: "Unanswered: Which week?", href: "/issues/GRE-e9" });
  });

  it("leaves out a reason that only repeats the title", () => {
    const [group] = buildNeededFromYou({ cards: [card("1", "question", { reason: "Card 1" })], needsMe: null });
    expect(group.items[0].reason).toBeNull();
  });
});

describe("neededSummary", () => {
  const now = new Date("2026-10-15T12:00:00.000Z").getTime();
  it("says all clear when nothing waits", () => {
    expect(neededSummary([], now)).toContain("Nothing needs you right now");
  });
  it("counts the things and names the oldest wait", () => {
    const groups = buildNeededFromYou({ cards: [card("1", "question"), card("2", "approval", { createdAt: "2026-10-13T12:00:00.000Z" })], needsMe: null });
    expect(neededSummary(groups, now)).toBe("2 things need you. The oldest has waited 2 days.");
  });
  it("still counts rows put away for later, and says how many", () => {
    const groups = buildNeededFromYou({ cards: [card("1", "question")], needsMe: null });
    expect(neededSummary(groups, now, 2)).toMatch(/^3 things need you \(2 put away for later\)\./);
    expect(neededSummary([], now, 1)).toBe("1 thing needs you (1 put away for later).");
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
      [group("answer", ["a", "b"]), group("overdue", ["wait:t1"])],
      [
        { kind: "snooze", itemKey: neededLaterKey("a"), snoozedUntil: "2026-10-17T08:00:00Z" },
        { kind: "snooze", itemKey: neededLaterKey("wait:t1"), snoozedUntil: "2026-10-17T08:00:00Z" },
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
