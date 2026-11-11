import type { CommerceRow } from "@/api/website-commerce";
import { text } from "@/lib/commerce";

// Client recency (parity with the website's old portfolio health bar, src/store/client-recency.mjs): how long since
// each client company's latest timeline item. Active up to 7 days, steady to 30, quiet to 60, cold after that.

export const RECENCY = [
  { key: "active", label: "Active", help: "7 days or less" },
  { key: "steady", label: "Steady", help: "8 to 30 days" },
  { key: "quiet", label: "Quiet", help: "31 to 60 days" },
  { key: "cold", label: "Cold", help: "over 60 days" },
  { key: "none", label: "No timeline yet", help: "nothing on the timeline" },
] as const;
export type RecencyKey = (typeof RECENCY)[number]["key"];

export function daysSince(at: string | null | undefined, now = Date.now()): number | null {
  const time = at ? Date.parse(at) : Number.NaN;
  return Number.isNaN(time) ? null : Math.max(0, Math.floor((now - time) / 86_400_000));
}

export function recencyOf(at: string | null | undefined, now = Date.now()): RecencyKey {
  const days = daysSince(at, now);
  if (days === null) return "none";
  return days <= 7 ? "active" : days <= 30 ? "steady" : days <= 60 ? "quiet" : "cold";
}

/** Each client's latest timeline item: its date when it has one, otherwise when it was added. Deleted items are not listed. */
export function lastEngagementByClient(engagements: readonly CommerceRow[]): Map<string, string> {
  const latest = new Map<string, string>();
  for (const row of engagements) {
    const client = text(row.customer_id);
    const at = text(row.occurred_on) ?? text(row.created_at);
    if (!client || !at || Number.isNaN(Date.parse(at))) continue;
    const now = latest.get(client);
    if (!now || Date.parse(at) > Date.parse(now)) latest.set(client, at);
  }
  return latest;
}

/** "Last item 12 days ago", for a client row. */
export function recencyLine(at: string | null | undefined, now = Date.now()): string {
  const days = daysSince(at, now);
  if (days === null) return "No timeline yet";
  return days === 0 ? "Last item today" : days === 1 ? "Last item yesterday" : `Last item ${days} days ago`;
}

/** Timeline starters (parity with the site's engagement templates). Fill a new item; nothing saves until a person adds it. */
export const ENGAGEMENT_TEMPLATES: { label: string; row: CommerceRow }[] = [
  { label: "Kickoff", row: { kind: "kickoff", title: "Kickoff: mapping the climb", phase: "Discovery" } },
  { label: "Recap", row: { kind: "recap", title: "Meeting recap: " } },
  { label: "Milestone", row: { kind: "milestone", title: "Milestone: ", phase: "Build" } },
  { label: "Deliverable", row: { kind: "deliverable", title: "Deliverable: ", phase: "Build" } },
  { label: "Review", row: { kind: "review", title: "Review: measuring the return", phase: "Review" } },
];
