import { describe, expect, it } from "vitest";
import { myTasksListText } from "./my-tasks-text";

describe("myTasksListText", () => {
  it("groups tasks by who acts next, with links", () => {
    const tasks = [
      { id: "a", identifier: "GRE-1", title: "Sign off the pack", group: "needs_you" as const },
      { id: "b", identifier: "GRE-2", title: "Draft the brief", group: "waiting" as const },
      { id: "c", identifier: null, title: "Call Ben", group: "needs_you" as const },
    ];
    const text = myTasksListText(tasks, (task) => task.group, (href) => `https://app${href}`, new Date(2026, 9, 16));
    expect(text).toBe(
      [
        "Your desk, 16 Oct",
        "3 tasks: 2 need you, 1 waiting on an agent.",
        "",
        "Needs you",
        "• GRE-1 Sign off the pack https://app/issues/GRE-1",
        "• Call Ben https://app/issues/c",
        "",
        "Waiting on an agent",
        "• GRE-2 Draft the brief https://app/issues/GRE-2",
      ].join("\n"),
    );
  });

  it("says one task in the singular", () => {
    const text = myTasksListText(
      [{ id: "a", identifier: "GRE-1", title: "Done thing" }],
      () => "done_today",
      (href) => href,
      new Date(2026, 9, 16),
    );
    expect(text.split("\n")[1]).toBe("1 task: 1 done today.");
  });
});
