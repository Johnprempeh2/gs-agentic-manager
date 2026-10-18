import type { WorkflowTemplateDefinition } from "@greatstone/shared";

const MAX_KEY = 48;
const MAX_STEPS = 30;

export interface WorkflowSourceTask {
  title: string;
  assigneeAgentId?: string | null;
}

export interface WorkflowSourceSubtask {
  id: string;
  title: string;
  description?: string | null;
  assigneeAgentId?: string | null;
  status?: string;
  createdAt?: Date | string | null;
  blockedBy?: Array<{ id: string }> | null;
}

/** A short lowercase slug the workflow validators accept, such as "client-onboarding". */
export function workflowKey(text: string, fallback = "workflow"): string {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_KEY)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : fallback;
}

function uniqueKey(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, MAX_KEY - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Drop the "<parent title>: " prefix that started workflows put on step tasks. */
function stepTitle(parentTitle: string, title: string): string {
  const prefix = `${parentTitle}: `;
  const trimmed = title.startsWith(prefix) ? title.slice(prefix.length) : title;
  return trimmed.trim().slice(0, 200) || "Step";
}

function createdTime(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

/**
 * Turns a finished (or running) task and its subtasks into a workflow
 * definition: one step per subtask in the order they were made, with the same
 * agents and the "wait for" links between them kept. Cancelled subtasks are
 * left out. Returns null when there is nothing to save.
 */
export function workflowDefinitionFromTask(
  task: WorkflowSourceTask,
  subtasks: WorkflowSourceSubtask[],
): WorkflowTemplateDefinition | null {
  const ordered = subtasks
    .filter((subtask) => subtask.status !== "cancelled")
    .map((subtask, index) => ({ subtask, index }))
    .sort((a, b) => createdTime(a.subtask.createdAt) - createdTime(b.subtask.createdAt) || a.index - b.index)
    .slice(0, MAX_STEPS)
    .map(({ subtask }) => subtask);
  if (ordered.length === 0) return null;

  const used = new Set<string>();
  const keyById = new Map<string, string>();
  const steps = ordered.map((subtask) => {
    const title = stepTitle(task.title, subtask.title);
    const key = uniqueKey(workflowKey(title, "step"), used);
    used.add(key);
    const blockedBy = (subtask.blockedBy ?? [])
      .map((blocker) => keyById.get(blocker.id))
      .filter((blockerKey): blockerKey is string => Boolean(blockerKey));
    keyById.set(subtask.id, key);
    return {
      key,
      title,
      description: subtask.description ? subtask.description.slice(0, 20_000) : null,
      assigneeAgentId: subtask.assigneeAgentId ?? null,
      documents: [],
      blockedBy: [...new Set(blockedBy)],
    };
  });

  return {
    version: 1,
    coordinator: { description: null, assigneeAgentId: task.assigneeAgentId ?? null, documents: [] },
    steps,
    reviews: [],
  };
}
