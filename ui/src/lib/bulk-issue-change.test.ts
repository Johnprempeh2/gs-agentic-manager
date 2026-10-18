import { describe, expect, it } from "vitest";
import { parseBulkIssueChange, taskCount } from "./bulk-issue-change";

const agents = [{ id: "a1", name: "Ridge" }];

describe("parseBulkIssueChange", () => {
  it("reads a status, a priority and an assignee", () => {
    expect(parseBulkIssueChange("status:done", agents)).toEqual({ data: { status: "done" }, label: "Done", field: "status" });
    expect(parseBulkIssueChange("priority:high", agents)).toEqual({ data: { priority: "high" }, label: "High priority", field: "priority" });
    expect(parseBulkIssueChange("assignee:a1", agents)).toEqual({ data: { assigneeAgentId: "a1" }, label: "Ridge", field: "assignee" });
  });

  it("refuses unknown or unsafe choices", () => {
    expect(parseBulkIssueChange("", agents)).toBeNull();
    expect(parseBulkIssueChange("status:blocked", agents)).toBeNull();
    expect(parseBulkIssueChange("assignee:missing", agents)).toBeNull();
    expect(parseBulkIssueChange("title:x", agents)).toBeNull();
  });

  it("counts tasks", () => {
    expect(taskCount(1)).toBe("1 task");
    expect(taskCount(3)).toBe("3 tasks");
  });
});
