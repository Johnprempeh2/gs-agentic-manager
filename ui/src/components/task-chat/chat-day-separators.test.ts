import { describe, expect, it } from "vitest";
import type { TaskChatItem } from "./task-chat-model";
import { chatDayLabel, chatDaySeparators } from "./TaskChatThreadView";

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

  // Review 2: a run row that started after midnight belongs under "Today".
  it("dates a run row by its reply, and shows the year on an older date", () => {
    const turn = {
      item: { id: "t", kind: "turn", items: [], settled: true, summary: { toolCount: 0, added: 0, removed: 0 },
        finalResponse: { id: "r", kind: "message", author: "agent", text: "r", createdAtIso: new Date(2026, 9, 1, 0, 35).toISOString() } } as unknown as TaskChatItem,
    };
    const labels = chatDaySeparators(groups(message("a", new Date(2026, 8, 30, 21, 2)), turn), now);
    expect([...labels.entries()].map(([entry, label]) => [entry.item.id, label])).toEqual([["a", "Yesterday"], ["t", "Today"]]);
    expect(chatDayLabel(new Date(2025, 9, 2, 12).toISOString(), now)).toBe("2 Oct 2025");
  });

  it("ignores items with no time", () => {
    expect(chatDaySeparators(groups(message("x", null)), now).size).toBe(0);
  });
});
