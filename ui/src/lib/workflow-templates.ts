import { workflowTemplateDefinitionSchema, type WorkflowTemplateDefinition } from "@greatstone/shared";

/** "8 steps · 3 human checks · 2 unassigned" */
export function workflowTemplateSummary(definition: WorkflowTemplateDefinition): string {
  const steps = definition.steps.length;
  const checks = definition.reviews.length;
  const unassigned = definition.steps.filter((step) => !step.assigneeAgentId).length;
  const parts = [`${steps} ${steps === 1 ? "step" : "steps"}`, `${checks} human ${checks === 1 ? "check" : "checks"}`];
  if (unassigned > 0) parts.push(`${unassigned} unassigned`);
  return parts.join(" · ");
}

/** Reviews that gate each step, keyed by step key, in template order. */
export function reviewsByStep(definition: WorkflowTemplateDefinition) {
  const map = new Map<string, WorkflowTemplateDefinition["reviews"]>();
  for (const review of definition.reviews) {
    map.set(review.stepKey, [...(map.get(review.stepKey) ?? []), review]);
  }
  return map;
}

/** Returns a copy with one step's (or, for key null, the coordinator's) assignee changed. */
export function withAssignee(
  definition: WorkflowTemplateDefinition,
  stepKey: string | null,
  agentId: string | null,
): WorkflowTemplateDefinition {
  if (stepKey === null) {
    return { ...definition, coordinator: { ...definition.coordinator, assigneeAgentId: agentId } };
  }
  return {
    ...definition,
    steps: definition.steps.map((step) => (step.key === stepKey ? { ...step, assigneeAgentId: agentId } : step)),
  };
}

/** Parses the JSON editor text. Returns the definition, or the first problem in plain words. */
export function parseDefinitionText(
  text: string,
): { ok: true; definition: WorkflowTemplateDefinition } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "This is not valid JSON." };
  }
  const parsed = workflowTemplateDefinitionSchema.safeParse(raw);
  if (parsed.success) return { ok: true, definition: parsed.data };
  const issue = parsed.error.issues[0];
  const where = issue.path.length > 0 ? ` (at ${issue.path.join(".")})` : "";
  return { ok: false, error: `${issue.message}${where}` };
}
