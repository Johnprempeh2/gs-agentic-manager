import { describe, expect, it } from "vitest";
import type { DecisionCard } from "@greatstone/shared";
import { openItemsByQueue } from "./DecisionQueueRail";

const item = (id: string, queues: string[]) => ({ id, queues: queues.map((key) => ({ key, title: key })) });
const card = (...items: ReturnType<typeof item>[]) => ({ items }) as unknown as DecisionCard;

describe("openItemsByQueue", () => {
  it("counts each open item once per queue it belongs to", () => {
    const counts = openItemsByQueue({
      cards: [
        card(item("a", ["questions"]), item("b", ["questions", "plans"])),
        // The same item merged into a second card still counts once.
        card(item("b", ["questions", "plans"]), item("c", [])),
      ],
    });
    expect(Object.fromEntries(counts)).toEqual({ questions: 2, plans: 1 });
  });

  it("is empty when nothing is open, whatever the queues once held", () => {
    expect(openItemsByQueue({ cards: [] }).size).toBe(0);
  });
});
