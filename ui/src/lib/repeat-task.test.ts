import { describe, expect, it } from "vitest";
import { repeatTaskDefaults } from "./repeat-task";

const base = {
  title: "Weekly pipeline summary",
  description: "Summarise the pipeline.\n\nDone when: the summary is in the task.",
  priority: "high",
  projectId: "p1",
  goalId: "g1",
  assigneeAgentId: "a1",
  assigneeUserId: null,
} as const;

describe("repeatTaskDefaults", () => {
  it("copies the brief, owner, project and goal", () => {
    expect(repeatTaskDefaults(base)).toEqual({
      title: "Weekly pipeline summary",
      description: "Summarise the pipeline.\n\nDone when: the summary is in the task.",
      priority: "high",
      projectId: "p1",
      goalId: "g1",
      assigneeAgentId: "a1",
    });
  });

  it("leaves out empty fields and falls back to a person owner", () => {
    expect(
      repeatTaskDefaults({
        ...base,
        description: null,
        projectId: null,
        goalId: null,
        assigneeAgentId: null,
        assigneeUserId: "u1",
      }),
    ).toEqual({ title: "Weekly pipeline summary", priority: "high", assigneeUserId: "u1" });
  });
});
