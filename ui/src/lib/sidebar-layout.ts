import type { SidebarLayout } from "@greatstone/shared";

export interface SidebarSectionDefault {
  id: string;
  label: string;
  items: readonly string[];
  /** Folded until the user opens it. */
  collapsed?: boolean;
}

/**
 * The default sidebar, grouped by what an executive does rather than how the
 * app is built (PR #551 audit): what needs you, chats, clients, work, team, and
 * a folded Admin section for the builder and configuration pages. Every
 * destination appears exactly once; feature switches decide which ones render.
 */
export const SIDEBAR_SECTIONS: readonly SidebarSectionDefault[] = [
  { id: "today", label: "Today", items: ["needed", "decisions", "my-tasks", "inbox", "calendar"] },
  { id: "chats", label: "Chats", items: ["chats"] },
  { id: "clients", label: "Clients", items: ["organisations", "pipelines", "deep-dive", "deliverables"] },
  {
    id: "work",
    label: "Work",
    items: ["dashboard", "tasks", "projects", "goals", "board", "intelligence", "memory"],
  },
  { id: "team", label: "Team", items: ["agents", "scorecard", "weekly-report", "conference-room", "status"] },
  {
    id: "admin",
    label: "Admin",
    collapsed: true,
    items: [
      "skills",
      "connectors",
      "routines",
      "workflows",
      "workspaces",
      "artifacts",
      "cases",
      "website",
      "activity",
      "releases",
      "billing",
      "settings",
      "design-guide",
    ],
  },
];

export const SIDEBAR_SECTION_IDS = SIDEBAR_SECTIONS.map((section) => section.id);

export interface ResolvedSidebarSection {
  id: string;
  label: string;
  items: string[];
  open: boolean;
}

export interface ResolvedSidebarLayout {
  sections: ResolvedSidebarSection[];
  hidden: string[];
  pinned: string[];
}

const HOME = new Map(SIDEBAR_SECTIONS.flatMap((section) => section.items.map((id) => [id, section.id] as const)));

function known(ids: readonly string[] | undefined): string[] {
  return [...new Set(ids ?? [])].filter((id) => HOME.has(id));
}

/**
 * Merge a user's saved layout over today's defaults. Items the sidebar no
 * longer has are dropped; items the saved layout does not place (new in this
 * release) land in their default section, straight after the nearest item that
 * precedes them by default. Moved, hidden and pinned items stay where the user
 * put them.
 */
export function resolveSidebarLayout(saved?: SidebarLayout | null): ResolvedSidebarLayout {
  const placed = new Set<string>();
  const sections = SIDEBAR_SECTIONS.map((section) => {
    const items: string[] = [];
    for (const id of saved?.sections?.[section.id] ?? []) {
      if (!HOME.has(id) || placed.has(id)) continue;
      placed.add(id);
      items.push(id);
    }
    const folded = saved?.collapsed?.[section.id] ?? section.collapsed ?? false;
    return { id: section.id, label: section.label, items, open: !folded };
  });
  SIDEBAR_SECTIONS.forEach((section, sectionIndex) => {
    const target = sections[sectionIndex]!;
    section.items.forEach((id, index) => {
      if (placed.has(id)) return;
      let at = 0;
      for (let before = index - 1; before >= 0; before -= 1) {
        const position = target.items.indexOf(section.items[before]!);
        if (position >= 0) {
          at = position + 1;
          break;
        }
      }
      target.items.splice(at, 0, id);
      placed.add(id);
    });
  });
  const hidden = known(saved?.hidden);
  const pinned = known(saved?.pinned).filter((id) => !hidden.includes(id));
  return { sections, hidden, pinned };
}

/**
 * Put `id` into `sectionId` at `index`, where `index` is the position of the
 * item it is dropped on (before the move), so it behaves like an array move
 * within one section and an insert before the target across sections.
 */
export function moveSidebarItem(saved: SidebarLayout, id: string, sectionId: string, index: number): SidebarLayout {
  const { sections } = resolveSidebarLayout(saved);
  const target = sections.find((section) => section.id === sectionId);
  if (!target || !HOME.has(id)) return saved;
  for (const section of sections) {
    const at = section.items.indexOf(id);
    if (at >= 0) section.items.splice(at, 1);
  }
  target.items.splice(Math.max(0, Math.min(index, target.items.length)), 0, id);
  return { ...saved, sections: Object.fromEntries(sections.map((section) => [section.id, section.items])) };
}

/** Move one place up (-1) or down (+1) among the items that are shown; past either end is a no-op. */
export function moveSidebarItemBy(
  saved: SidebarLayout,
  id: string,
  delta: -1 | 1,
  isShown: (id: string) => boolean = () => true,
): SidebarLayout {
  const section = resolveSidebarLayout(saved).sections.find((candidate) => candidate.items.includes(id));
  if (!section) return saved;
  const shown = section.items.filter((item) => item === id || isShown(item));
  const neighbour = shown[shown.indexOf(id) + delta];
  if (!neighbour) return saved;
  return moveSidebarItem(saved, id, section.id, section.items.indexOf(neighbour));
}

export function setSidebarItemHidden(saved: SidebarLayout, id: string, hidden: boolean): SidebarLayout {
  const current = known(saved.hidden).filter((item) => item !== id);
  return {
    ...saved,
    hidden: hidden ? [...current, id] : current,
    // A hidden item is no longer a favourite.
    pinned: hidden ? known(saved.pinned).filter((item) => item !== id) : saved.pinned,
  };
}

export function setSidebarItemPinned(saved: SidebarLayout, id: string, pinned: boolean): SidebarLayout {
  const current = known(saved.pinned).filter((item) => item !== id);
  return { ...saved, pinned: pinned ? [...current, id] : current };
}

export function setSidebarSectionOpen(saved: SidebarLayout, sectionId: string, open: boolean): SidebarLayout {
  return { ...saved, collapsed: { ...saved.collapsed, [sectionId]: !open } };
}
