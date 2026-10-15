import { describe, expect, it } from "vitest";
import type { Issue } from "@greatstone/shared";
import { csvCell, issuesCsvFileName, issuesToCsv } from "./issues-csv";

const lookups = {
  statusLabel: (status: string) => (status === "in_progress" ? "In progress" : "Todo"),
  agentName: (id: string) => (id === "a1" ? "Everest" : null),
  userLabel: (id: string) => (id === "u1" ? "Ben" : null),
  projectName: (id: string) => (id === "p1" ? "Indago" : null),
  taskUrl: (issue: Issue) => `https://gsam.test/GRE/issues/${issue.identifier}`,
};

function issue(overrides: Partial<Issue>): Issue {
  return {
    id: "i1",
    identifier: "GRE-1",
    title: "Send the proposal",
    status: "todo",
    priority: "high",
    assigneeAgentId: null,
    assigneeUserId: null,
    projectId: null,
    dueDate: null,
    createdAt: new Date("2026-10-01T09:00:00Z"),
    updatedAt: new Date("2026-10-02T09:00:00Z"),
    completedAt: null,
    ...overrides,
  } as Issue;
}

describe("issues CSV", () => {
  it("writes a header and one row per task, with names instead of ids", () => {
    const csv = issuesToCsv(
      [
        issue({ assigneeAgentId: "a1", projectId: "p1", status: "in_progress", dueDate: "2026-10-20" }),
        issue({ id: "i2", identifier: "GRE-2", title: "Call Ben, then \"confirm\"", assigneeUserId: "u1" }),
      ],
      lookups as never,
    );
    expect(csv.startsWith("﻿Key,Title,Status")).toBe(true);
    const lines = csv.slice(1).trim().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe(
      "GRE-1,Send the proposal,In progress,High,Everest,Indago,2026-10-20,2026-10-01,2026-10-02,,https://gsam.test/GRE/issues/GRE-1",
    );
    expect(lines[2]).toContain('"Call Ben, then ""confirm"""');
    expect(lines[2]).toContain(",Ben,");
  });

  it("stops spreadsheet formulas from running", () => {
    expect(csvCell("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(csvCell("-5")).toBe("'-5");
    expect(csvCell("plain")).toBe("plain");
  });

  it("names the file after the company and the day", () => {
    expect(issuesCsvFileName("GRE", "2026-10-15")).toBe("gre-tasks-2026-10-15.csv");
    expect(issuesCsvFileName(null, "2026-10-15")).toBe("tasks-2026-10-15.csv");
  });
});
