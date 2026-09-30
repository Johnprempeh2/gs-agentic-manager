import { describe, expect, it } from "vitest";
import type { IssueWorkProduct } from "@greatstone/shared";
import type { TaskChatItem } from "./task-chat-model";
import { groupConsecutiveMedia } from "./TaskChatThreadView";

function resource(id: string, resourceKind: "deliverable" | "document", contentType = "image/png") {
  const item: TaskChatItem = {
    id,
    kind: "protocol",
    surface: "resource",
    resourceKind,
    title: id,
    subtitle: "",
    href: null,
    workProduct: resourceKind === "deliverable"
      ? ({ type: "artifact", title: id, metadata: { contentType } } as unknown as IssueWorkProduct)
      : undefined,
  };
  return { item };
}

describe("groupConsecutiveMedia", () => {
  it("puts back-to-back screenshots in one grid and leaves other items alone", () => {
    const groups = groupConsecutiveMedia([
      resource("before.png", "deliverable"),
      resource("after.png", "deliverable"),
      resource("notes", "document"),
      resource("report.zip", "deliverable", "application/zip"),
      resource("clip.webm", "deliverable", "video/webm"),
    ]);

    expect(groups.map((group) => [group.media, group.entries.map((entry) => entry.item.id)])).toEqual([
      [true, ["before.png", "after.png"]],
      [false, ["notes"]],
      [false, ["report.zip"]],
      [true, ["clip.webm"]],
    ]);
    expect(groups[3]?.previous?.id).toBe("report.zip");
  });
});
