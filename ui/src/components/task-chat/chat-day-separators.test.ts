import { describe, expect, it } from "vitest";
import type { TaskChatItem } from "./task-chat-model";
import { chatDaySeparators } from "./TaskChatThreadView";

const now = new Date(2026, 9, 1, 9, 0);
const message = (id: string, at: Date | null): { item: TaskChatItem } => ({
  item: { id, kind: "message", author: "human", text: id, createdAtIso: at?.toISOString() } as TaskChatItem,
});
const groups = (...entries: Array<{ item: TaskChatItem }>) => entries.map((entry) => ({ entries: [entry] }));

describe("chatDaySeparators", () => {
  it("labels each new day, and leaves an all-today thread unlabelled", () => {
    const old = message("a", new Date(2026, 8, 29, 21, 2));
    const sameDay = message("b", new Date(2026, 8, 29, 22, 0));
    const yesterday = message("c", new Date(2026, 8, 30, 21, 2));
    const today = message("d", new Date(2026, 9, 1, 8, 15));
    const labels = chatDaySeparators(groups(old, sameDay, yesterday, today), now);
    expect([...labels.entries()].map(([entry, label]) => [entry.item.id, label])).toEqual([
      ["a", "29 Sept"],
      ["c", "Yesterday"],
      ["d", "Today"],
    ]);
    expect(chatDaySeparators(groups(message("e", new Date(2026, 9, 1, 7, 0))), now).size).toBe(0);
  });

  it("ignores items with no time", () => {
    expect(chatDaySeparators(groups(message("x", null)), now).size).toBe(0);
  });
});
