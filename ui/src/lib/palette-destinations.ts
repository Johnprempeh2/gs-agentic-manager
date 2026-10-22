/**
 * Places the command palette can jump to by name: pages (labelled as in the
 * sidebar, so "Audit" finds the page the sidebar calls Audit), Settings pages,
 * and the organisation's agents, projects and goals.
 */
export type PaletteDestinationKind = "page" | "settings" | "agent" | "project" | "goal" | "task";

export interface PaletteDestination {
  kind: PaletteDestinationKind;
  id: string;
  label: string;
  path: string;
  /** Other words that should find it (old names, what is on the page). */
  keywords?: readonly string[];
  /** Searched too, ranked below the label and keywords (a project's description). */
  detail?: string | null;
  /** A task's key (GRE-12): typing it exactly, or its start, ranks first. */
  key?: string | null;
}

/** Pages, in the order the empty palette lists them. Labels match the sidebar. */
export const PALETTE_PAGES: readonly PaletteDestination[] = [
  { kind: "page", id: "desk", label: "Desk", path: "/desk", keywords: ["my tasks", "home"] },
  { kind: "page", id: "decisions", label: "Decisions", path: "/desk#desk-needs-me", keywords: ["needs me", "approvals"] },
  { kind: "page", id: "pinned", label: "Pinned", path: "/desk", keywords: ["pins", "followed"] },
  { kind: "page", id: "needed", label: "Needed from you", path: "/needed", keywords: ["waiting on me"] },
  { kind: "page", id: "inbox", label: "Inbox", path: "/inbox", keywords: ["unread", "messages"] },
  { kind: "page", id: "calendar", label: "Calendar", path: "/calendar", keywords: ["deadlines", "dates"] },
  { kind: "page", id: "dashboard", label: "Dashboard", path: "/dashboard", keywords: ["overview"] },
  { kind: "page", id: "tasks", label: "Tasks", path: "/issues", keywords: ["issues"] },
  { kind: "page", id: "projects", label: "Projects", path: "/projects" },
  { kind: "page", id: "goals", label: "Goals", path: "/goals", keywords: ["objectives", "kpi"] },
  { kind: "page", id: "agents", label: "Agents", path: "/agents", keywords: ["team"] },
  { kind: "page", id: "deliverables", label: "Deliverables", path: "/deliverables", keywords: ["documents"] },
  { kind: "page", id: "studio", label: "GS Studio", path: "/images", keywords: ["images", "video", "pictures"] },
  { kind: "page", id: "scorecard", label: "Scorecard", path: "/scorecard" },
  { kind: "page", id: "this-week", label: "This week", path: "/weekly-report", keywords: ["weekly report"] },
  { kind: "page", id: "costs", label: "Costs", path: "/costs", keywords: ["spend", "budget"] },
  { kind: "page", id: "audit", label: "Audit", path: "/activity", keywords: ["activity", "history", "log"] },
  { kind: "page", id: "pipelines", label: "Clients and pipelines", path: "/pipelines", keywords: ["deals", "crm"] },
  { kind: "page", id: "organisations", label: "Organisations", path: "/organisations", keywords: ["companies", "crm"] },
  { kind: "page", id: "settings", label: "Settings", path: "/company/settings", keywords: ["general", "organisation"] },
];

/** Settings pages, found by name ("members", "secrets") but not listed in the empty palette. */
export const PALETTE_SETTINGS_PAGES: readonly PaletteDestination[] = [
  { kind: "settings", id: "settings-profile", label: "Profile", path: "/company/settings/instance/profile", keywords: ["settings", "account", "me"] },
  { kind: "settings", id: "settings-members", label: "Members", path: "/company/settings/members", keywords: ["settings", "people", "invites", "access"] },
  { kind: "settings", id: "settings-integrations", label: "Integrations", path: "/company/settings/integrations", keywords: ["settings", "connections"] },
  { kind: "settings", id: "settings-secrets", label: "Secrets", path: "/company/settings/secrets", keywords: ["settings", "keys", "passwords"] },
  { kind: "settings", id: "settings-export", label: "Export", path: "/company/export", keywords: ["settings", "download", "backup"] },
];

const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * How well `query` names `destination`; `null` when it does not. Every query
 * word must start a word of the label or a keyword (so "port" finds "Client
 * portal" but "ort" does not), or appear in the detail. A whole-label match
 * beats a label prefix, which beats a later word, which beats a keyword.
 */
export function scoreDestination(query: string, destination: PaletteDestination): number | null {
  const q = query.trim().toLowerCase();
  const qWords = words(q);
  if (qWords.length === 0) return null;
  const label = destination.label.toLowerCase();
  const key = destination.key?.toLowerCase();
  if (label === q || key === q) return 1000;
  if (key && !/\s/.test(q) && key.startsWith(q)) return 950 - key.length;
  // By title, a task ranks below a page, agent, project or goal of the same name.
  const penalty = destination.kind === "task" ? 400 : 0;
  if (label.startsWith(q)) return 900 - penalty - label.length;
  const labelWords = words(label);
  if (qWords.every((w) => labelWords.some((lw) => lw.startsWith(w)))) return 700 - penalty - label.length;
  const keywordWords = (destination.keywords ?? []).flatMap(words);
  if (qWords.every((w) => labelWords.some((lw) => lw.startsWith(w)) || keywordWords.some((kw) => kw.startsWith(w)))) {
    return 500 - penalty - label.length;
  }
  if (destination.kind !== "task" && destination.detail && destination.detail.toLowerCase().includes(q)) return 100;
  return null;
}

/**
 * Destinations named by `query`, best first; ties keep the given order. At most
 * `taskLimit` tasks, so the full task list further down keeps its job.
 */
export function rankDestinations(
  query: string,
  destinations: readonly PaletteDestination[],
  limit: number,
  taskLimit = 2,
): PaletteDestination[] {
  let tasks = 0;
  return destinations
    .map((destination, index) => ({ destination, index, score: scoreDestination(query, destination) }))
    .filter((entry): entry is { destination: PaletteDestination; index: number; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .filter(({ destination }) => destination.kind !== "task" || tasks++ < taskLimit)
    .slice(0, limit)
    .map((entry) => entry.destination);
}
