import { describe, expect, it } from "vitest";
import { agentWorkloadLine } from "./agent-workload";

const today = new Date(2026, 9, 18);

describe("agentWorkloadLine", () => {
  it("counts only the agent's own open tasks, busiest status first", () => {
    const line = agentWorkloadLine(
      [
        { assigneeAgentId: "a1", status: "todo", dueDate: null },
        { assigneeAgentId: "a1", status: "in_progress", dueDate: null },
        { assigneeAgentId: "a1", status: "todo", dueDate: "2026-10-01" },
        { assigneeAgentId: "a1", status: "done", dueDate: "2026-10-01" },
        { assigneeAgentId: "a2", status: "blocked", dueDate: null },
      ],
      "a1",
      today,
    );
    expect(line).toBe("1 in progress, 2 to do (1 overdue)");
  });

  it("returns null when the agent has nothing open", () => {
    expect(agentWorkloadLine([{ assigneeAgentId: "a1", status: "done", dueDate: null }], "a1", today)).toBeNull();
  });
});
