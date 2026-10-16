import { describe, expect, it } from "vitest";
import type { Issue } from "@greatstone/shared";
import { issuesToPlainList } from "./issues-text";

const lookups = {
  statusLabel: (status: Issue["status"]) => (status === "in_progress" ? "In progress" : "To do"),
  agentName: (id: string) => (id === "a1" ? "Ridge" : null),
  userLabel: (id: string) => (id === "u1" ? "Ben" : null),
};

function issue(overrides: Partial<Issue>): Issue {
  return { id: "i1", identifier: "GRE-12", title: "Send the proposal", status: "todo", ...overrides } as Issue;
}

describe("issuesToPlainList", () => {
  it("writes one line per task with status, who and the due date", () => {
    expect(
      issuesToPlainList(
        [
          issue({ status: "in_progress", assigneeAgentId: "a1", dueDate: "2026-10-20" }),
          issue({ id: "i2", identifier: null, title: "Call the bank", assigneeUserId: "u1" }),
        ],
        lookups,
      ),
    ).toBe("• GRE-12 Send the proposal (In progress, Ridge, due 20 Oct)\n• Call the bank (To do, Ben)");
  });

  it("leaves out a responsible name it cannot find", () => {
    expect(issuesToPlainList([issue({ assigneeAgentId: "gone" })], lookups)).toBe("• GRE-12 Send the proposal (To do)");
  });
});
