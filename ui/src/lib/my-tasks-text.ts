import type { Issue } from "@greatstone/shared";
import { MY_TASKS_GROUPS, MY_TASKS_GROUP_LABELS, type MyTasksGroup } from "./myTasks";
import { formatShortDate } from "./utils";

type TaskLike = Pick<Issue, "id" | "identifier" | "title">;

/**
 * "Copy as a list" on My tasks: the tasks grouped by who acts next, one line
 * per task with a link, ready to paste into a message.
 *
 *   Your desk, 16 Oct
 *   3 tasks: 2 need you, 1 waiting on an agent.
 *
 *   Needs you
 *   • GRE-12 Sign off the Q3 pack https://...
 */
export function myTasksListText<T extends TaskLike>(
  tasks: readonly T[],
  groupOf: (task: T) => MyTasksGroup,
  linkFor: (href: string) => string,
  now: Date = new Date(),
): string {
  const byGroup = new Map<MyTasksGroup, T[]>(MY_TASKS_GROUPS.map((group) => [group, []]));
  for (const task of tasks) byGroup.get(groupOf(task))?.push(task);
  const counts = MY_TASKS_GROUPS.filter((group) => byGroup.get(group)!.length > 0).map((group) => {
    const n = byGroup.get(group)!.length;
    if (group === "needs_you") return `${n} ${n === 1 ? "needs" : "need"} you`;
    if (group === "waiting") return `${n} waiting on an agent`;
    return `${n} done today`;
  });
  const total = tasks.length;
  const lines = [
    `Your desk, ${formatShortDate(now)}`,
    `${total} ${total === 1 ? "task" : "tasks"}${counts.length > 0 ? `: ${counts.join(", ")}` : ""}.`,
  ];
  for (const group of MY_TASKS_GROUPS) {
    const items = byGroup.get(group)!;
    if (items.length === 0) continue;
    lines.push("", MY_TASKS_GROUP_LABELS[group]);
    for (const task of items) {
      const ref = task.identifier ?? task.id;
      lines.push(`• ${task.identifier ? `${task.identifier} ` : ""}${task.title} ${linkFor(`/issues/${ref}`)}`);
    }
  }
  return lines.join("\n");
}
