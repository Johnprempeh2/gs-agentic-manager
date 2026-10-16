import type { Deliverable } from "@greatstone/shared";
import { formatShortDate } from "./utils";

interface DeliverableGroupLike {
  label?: string | null;
  items: readonly Deliverable[];
}

/**
 * "Copy as a list" on Deliverables: what is on screen, grouped as shown, one
 * line per document with a link, ready to paste into an email.
 *
 *   Deliverables, 16 Oct
 *   2 deliverables.
 *
 *   • Q3 board pack, Website relaunch https://...
 */
export function deliverablesListText(
  groups: readonly DeliverableGroupLike[],
  linkFor: (deliverable: Deliverable) => string,
  now: Date = new Date(),
): string {
  const count = groups.reduce((sum, group) => sum + group.items.length, 0);
  const lines = [`Deliverables, ${formatShortDate(now)}`, `${count} ${count === 1 ? "deliverable" : "deliverables"}.`];
  for (const group of groups) {
    if (group.items.length === 0) continue;
    lines.push("");
    if (group.label) lines.push(group.label);
    for (const item of group.items) {
      const where = item.clientCase?.name ?? item.project?.name ?? null;
      lines.push(`• ${item.title}${where ? `, ${where}` : ""} ${linkFor(item)}`);
    }
  }
  return lines.join("\n");
}
