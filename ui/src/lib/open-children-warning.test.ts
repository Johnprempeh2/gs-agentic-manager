import { describe, expect, it } from "vitest";
import { openChildrenWarning } from "./open-children-warning";

describe("openChildrenWarning", () => {
  it("is quiet when nothing is open", () => {
    expect(openChildrenWarning(undefined)).toBeNull();
    expect(openChildrenWarning([])).toBeNull();
  });

  it("names up to three open subtasks", () => {
    expect(openChildrenWarning([{ id: "a", identifier: "GRE-2", title: "Draft", status: "todo" }])).toEqual({
      title: "Marked done, but 1 subtask is still open",
      body: "GRE-2. Finish, cancel or hand it over.",
    });
    const many = ["GRE-2", "GRE-3", null, "GRE-5"].map((identifier, index) => ({
      id: String(index),
      identifier,
      title: `Task ${index}`,
      status: "todo",
    }));
    expect(openChildrenWarning(many)).toEqual({
      title: "Marked done, but 4 subtasks are still open",
      body: "GRE-2, GRE-3, Task 2 and 1 more. Finish, cancel or hand them over.",
    });
  });
});
