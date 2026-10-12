import { describe, expect, it } from "vitest";
import type { TaskChatMessageItem } from "./task-chat-model";
import { taskChatItemSpacingClass } from "./TaskChatThreadView";

function human(id: string, extra: Partial<TaskChatMessageItem> = {}): TaskChatMessageItem {
  return { id, kind: "message", author: "human", text: id, ...extra };
}

describe("taskChatItemSpacingClass (GRE-1012)", () => {
  const ben = { authorName: "Ben Kafui Mensah", fromOtherUser: true } as const;

  it("pulls a teammate's follow-up close to their previous bubble", () => {
    expect(
      taskChatItemSpacingClass(
        human("b2", { ...ben, showAuthorName: false }),
        human("b1", { ...ben, showAuthorName: true }),
      ),
    ).toBe("mt-2");
  });

  it("keeps the full gap before a new speaker", () => {
    expect(
      taskChatItemSpacingClass(human("b1", { ...ben, showAuthorName: true }), human("me")),
    ).toBe("mt-6");
    expect(taskChatItemSpacingClass(human("me"), human("b1", ben))).toBe("mt-6");
  });
});
