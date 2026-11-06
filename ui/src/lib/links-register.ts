import type { LinkItem, LinkStatus, LinkType } from "@greatstone/shared";

export const LINK_TYPE_LABELS: Record<LinkType, string> = {
  proposal: "Proposal",
  demo: "Demo",
  recap: "Recap",
  portal: "Portal",
  deck: "Deck",
  report: "Report",
  preview: "Preview",
  other: "Other",
};

export const LINK_STATUS_LABELS: Record<LinkStatus, string> = {
  live: "Live",
  draft: "Draft",
  archived: "Archived",
  broken: "Broken",
};

export const NO_CLIENT_LABEL = "No client";

export interface LinkGroup {
  key: string;
  label: string;
  items: LinkItem[];
}

/** The client a link is filed under: its client page, else the name it was imported with. */
export function linkClientLabel(link: Pick<LinkItem, "clientCase" | "clientName">): string | null {
  return link.clientCase?.name ?? link.clientName ?? null;
}

/**
 * The default view: one group per client, A to Z, with links that have no
 * client last. Within a group the server's order (newest first) is kept.
 */
export function groupLinksByClient(links: LinkItem[]): LinkGroup[] {
  const groups = new Map<string, LinkGroup>();
  for (const link of links) {
    const label = linkClientLabel(link);
    const key = link.clientCase ? `case:${link.clientCase.id}` : label ? `name:${label.toLowerCase()}` : "none";
    const group = groups.get(key) ?? { key, label: label ?? NO_CLIENT_LABEL, items: [] };
    group.items.push(link);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.key === "none") return 1;
    if (b.key === "none") return -1;
    return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  });
}

/** "acme.netlify.app/proposal" — the address without the scheme, for a row's second line. */
export function shortLinkUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
    return `${parsed.host}${path}${parsed.search}`;
  } catch {
    return url;
  }
}
