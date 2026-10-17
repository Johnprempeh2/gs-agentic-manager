import { describe, expect, it } from "vitest";
import { workflowTemplateDefinitionSchema } from "@greatstone/shared";
import { workflowDefinitionFromTask, workflowKey } from "./workflow-from-task";

describe("workflowKey", () => {
  it("makes a lowercase slug the validators accept", () => {
    expect(workflowKey("Client onboarding: Week 1!")).toBe("client-onboarding-week-1");
    expect(workflowKey("!!!")).toBe("workflow");
    expect(workflowKey("x".repeat(80)).length).toBe(48);
  });
});

describe("workflowDefinitionFromTask", () => {
  const task = { title: "Launch", assigneeAgentId: "11111111-1111-4111-8111-111111111111" };

  it("returns null when there are no subtasks to keep", () => {
    expect(workflowDefinitionFromTask(task, [])).toBeNull();
    expect(workflowDefinitionFromTask(task, [{ id: "a", title: "Gone", status: "cancelled" }])).toBeNull();
  });

  it("keeps order, agents and earlier blockers, and passes the shared schema", () => {
    const definition = workflowDefinitionFromTask(task, [
      {
        id: "b",
        title: "Launch: Write copy",
        createdAt: "2026-10-02T00:00:00Z",
        blockedBy: [{ id: "a" }, { id: "outside" }],
        assigneeAgentId: "22222222-2222-4222-8222-222222222222",
      },
      { id: "a", title: "Research", createdAt: "2026-10-01T00:00:00Z", description: "Find three examples." },
      { id: "c", title: "Research", createdAt: "2026-10-03T00:00:00Z", blockedBy: [{ id: "b" }] },
    ]);
    expect(definition).not.toBeNull();
    expect(definition!.steps.map((step) => [step.key, step.title, step.blockedBy])).toEqual([
      ["research", "Research", []],
      ["write-copy", "Write copy", ["research"]],
      ["research-2", "Research", ["write-copy"]],
    ]);
    expect(definition!.steps[0]!.description).toBe("Find three examples.");
    expect(definition!.steps[1]!.assigneeAgentId).toBe("22222222-2222-4222-8222-222222222222");
    expect(definition!.coordinator.assigneeAgentId).toBe(task.assigneeAgentId);
    expect(workflowTemplateDefinitionSchema.safeParse(definition).success).toBe(true);
  });

  it("drops a blocker that comes later, so the plan has no cycles", () => {
    const definition = workflowDefinitionFromTask(task, [
      { id: "a", title: "First", createdAt: "2026-10-01T00:00:00Z", blockedBy: [{ id: "b" }] },
      { id: "b", title: "Second", createdAt: "2026-10-02T00:00:00Z" },
    ]);
    expect(definition!.steps[0]!.blockedBy).toEqual([]);
  });
});
