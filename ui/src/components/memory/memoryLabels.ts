import type {
  MemoryActorRef,
  MemoryGraphEdge,
  MemoryGraphEdgeType,
  MemoryRecordStatus,
  MemoryScopeKind,
  MemorySourceRef,
} from "@greatstone/shared";
import { AlertTriangle, CheckCircle2, CircleDashed, History, Trash2, type LucideIcon } from "lucide-react";

/** Plain words for each review state. Icon + text, so state never rests on colour alone. */
export const memoryStatusMeta: Record<MemoryRecordStatus, { label: string; icon: LucideIcon; hint: string }> = {
  unreviewed: { label: "Unreviewed", icon: CircleDashed, hint: "Not yet checked by a reviewer." },
  approved: { label: "Approved", icon: CheckCircle2, hint: "A reviewer approved it." },
  disputed: { label: "Disputed", icon: AlertTriangle, hint: "A reviewer disputed it." },
  superseded: { label: "Superseded", icon: History, hint: "A newer entry replaces it." },
  deleted: { label: "Deleted", icon: Trash2, hint: "Removed; only the history is kept." },
};

/** Short label for an edge, read from the "from" entry. Never a word that implies cause. */
export const edgeTypeLabel: Record<MemoryGraphEdgeType, string> = {
  supports: "Supports",
  contradicts: "Contradicts",
  refines: "Refines",
  depends_on: "Depends on",
  same_subject: "Same subject as",
  supersedes: "Replaces",
  possible_conflict: "May conflict with",
};

export const scopeKindLabel: Record<MemoryScopeKind, string> = {
  organization: "Organization",
  project: "Project",
  restricted_project: "Restricted project",
  client: "Client",
  agent: "Agent",
};

export const EDGE_KIND_LABEL = {
  explicit: "Stated link",
  inferred: "Found by a check",
} as const;

export function edgeLabel(edge: Pick<MemoryGraphEdge, "type">): string {
  return edgeTypeLabel[edge.type];
}

export function actorLabel(actor: MemoryActorRef | null | undefined): string {
  if (!actor) return "Unknown";
  if (actor.name) return actor.name;
  if (actor.actorType === "agent") return "An agent";
  if (actor.actorType === "user") return "A board member";
  return "A check";
}

const SOURCE_KIND_LABEL: Record<string, string> = {
  issue: "Task",
  comment: "Comment",
  document_revision: "Document",
  run: "Run",
  external_object: "External item",
  memory_conflict: "Conflict check",
};

/** Label and, where the app has a page for it, a link. Sources are ids only (GRE-864). */
export function sourceRef(source: MemorySourceRef | null | undefined): { label: string; href: string | null } | null {
  if (!source?.kind || !source.id) {
    return source?.runId ? { label: `Run ${source.runId.slice(0, 8)}`, href: null } : null;
  }
  const kind = SOURCE_KIND_LABEL[source.kind] ?? source.kind.replace(/_/g, " ");
  const href = source.kind === "issue" ? `/issues/${source.id}` : null;
  return { label: `${kind} ${source.id.slice(0, 8)}`, href };
}
