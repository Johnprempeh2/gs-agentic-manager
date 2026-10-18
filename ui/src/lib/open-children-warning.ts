export type OpenChildSummary = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
};

/**
 * The warning shown after a parent task is marked done while some of its
 * subtasks are still open. The server lists them on the update response; the
 * change itself is saved.
 */
export function openChildrenWarning(openChildren: OpenChildSummary[] | null | undefined) {
  if (!openChildren || openChildren.length === 0) return null;
  const count = openChildren.length;
  const named = openChildren
    .slice(0, 3)
    .map((child) => child.identifier ?? child.title)
    .join(", ");
  const more = count > 3 ? ` and ${count - 3} more` : "";
  return {
    title: `Marked done, but ${count} ${count === 1 ? "subtask is" : "subtasks are"} still open`,
    body: `${named}${more}. Finish, cancel or hand ${count === 1 ? "it" : "them"} over.`,
  };
}
