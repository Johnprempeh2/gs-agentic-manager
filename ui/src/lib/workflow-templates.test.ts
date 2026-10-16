import { describe, expect, it } from "vitest";
import { RESEARCH_PACK_WORKFLOW_TEMPLATE_PRESET } from "@greatstone/shared";
import { parseDefinitionText, reviewsByStep, withAssignee, workflowTemplateSummary } from "./workflow-templates";

const preset = RESEARCH_PACK_WORKFLOW_TEMPLATE_PRESET.definition;
const AGENT = "11111111-1111-4111-8111-111111111111";

describe("workflow template helpers", () => {
  it("summarises steps, checks and open assignments", () => {
    expect(workflowTemplateSummary(preset)).toBe("8 steps · 3 human checks · 8 unassigned");
    const assigned = preset.steps.reduce((def, step) => withAssignee(def, step.key, AGENT), preset);
    expect(workflowTemplateSummary(assigned)).toBe("8 steps · 3 human checks");
  });

  it("sets one step's or the coordinator's assignee without touching the rest", () => {
    const next = withAssignee(preset, "check", AGENT);
    expect(next.steps.find((step) => step.key === "check")?.assigneeAgentId).toBe(AGENT);
    expect(next.steps.filter((step) => step.assigneeAgentId).length).toBe(1);
    expect(preset.steps.find((step) => step.key === "check")?.assigneeAgentId).toBeNull();
    expect(withAssignee(preset, null, AGENT).coordinator.assigneeAgentId).toBe(AGENT);
  });

  it("groups R1-R3 under the steps they gate", () => {
    const byStep = reviewsByStep(preset);
    expect([...byStep.entries()].map(([key, reviews]) => [key, reviews.map((r) => r.key)])).toEqual([
      ["intake", ["r1"]],
      ["check", ["r2"]],
      ["deck", ["r3"]],
    ]);
  });

  it("explains a bad JSON edit in plain words", () => {
    expect(parseDefinitionText("{")).toEqual({ ok: false, error: "This is not valid JSON." });
    const backwards = structuredClone(preset);
    backwards.steps[0].blockedBy = ["deck"];
    const result = parseDefinitionText(JSON.stringify(backwards));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('can only wait for an earlier step, not "deck"');
    expect(parseDefinitionText(JSON.stringify(preset)).ok).toBe(true);
  });
});
