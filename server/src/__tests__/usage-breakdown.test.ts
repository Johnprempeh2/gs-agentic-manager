import { describe, expect, it } from "vitest";
import { classifyRunWork, stageAgentIds } from "../services/usage-breakdown.js";

const policy = (...agentIds: string[]) => ({
  stages: agentIds.map((agentId) => ({ type: "review", participants: [{ type: "agent", agentId }] })),
});

describe("usage breakdown work kinds", () => {
  it("reads agent reviewers from stages, ignoring people and junk", () => {
    expect(stageAgentIds(policy("a", "b"))).toEqual(["a", "b"]);
    expect(stageAgentIds({ stages: [{ participants: [{ type: "user", userId: "u" }] }] })).toEqual([]);
    expect(stageAgentIds(null)).toEqual([]);
  });

  it("classifies a run by the agent's relation to the task", () => {
    const task = { assigneeAgentId: "builder", originKind: "manual", executionPolicy: policy("reviewer") };
    expect(classifyRunWork("builder", task)).toBe("doing");
    expect(classifyRunWork("reviewer", task)).toBe("reviewing");
    expect(classifyRunWork("lead", task)).toBe("coordinating");
    expect(classifyRunWork("builder", { ...task, originKind: "routine_execution" })).toBe("routine");
    expect(classifyRunWork("anyone", null)).toBe("housekeeping");
  });

  it("counts an assignee who is also a listed reviewer as doing the task", () => {
    expect(classifyRunWork("x", { assigneeAgentId: "x", originKind: "manual", executionPolicy: policy("x") })).toBe("doing");
  });
});
