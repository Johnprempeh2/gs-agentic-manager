import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileCheck2 } from "lucide-react";
import { groupDeliverableDocuments, type DeliverableDocumentGroup } from "@greatstone/shared";
import { deliverablesApi, type Deliverable } from "@/api/deliverables";
import { AgentAvatar } from "@/components/AgentAvatar";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { useOptionalToastActions } from "@/context/ToastContext";
import { copyTextToClipboard } from "@/lib/clipboard";
import { queryKeys } from "@/lib/queryKeys";
import { cn, formatDate } from "@/lib/utils";
import { DELIVERABLE_KIND_LABELS } from "./DeliverableCard";
import { DeliverableStageBadge } from "./DeliverableBadges";
import { DeliverableQuickLook } from "./DeliverableQuickLook";
import { releaseLabel } from "./DeliverableVersionTimeline";

// The Deliverables tab on a project (Ben, 10 Nov): what the project has
// delivered, without leaving it and without the task detail. One card per
// document (older copies fold under the newest), latest delivered first.

export type ProjectDeliverableFilter = "all" | "delivered" | "client_facing";

const FILTERS: Array<{ value: ProjectDeliverableFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "delivered", label: "Delivered" },
  { value: "client_facing", label: "Client-facing" },
];

// ponytail: one page of 200 per project, filtered here; page the API if a project ever outgrows it.
const PROJECT_DELIVERABLES_LIMIT = 200;

export function projectDeliverablesQueryKey(companyId: string, projectId: string) {
  return queryKeys.deliverables.list(companyId, { projectId, scope: "project-tab" });
}

/** The project's deliverables, one entry per document, latest delivered first. */
export function useProjectDeliverables(companyId: string | null | undefined, projectId: string | null | undefined) {
  const query = useQuery({
    queryKey: projectDeliverablesQueryKey(companyId ?? "", projectId ?? ""),
    queryFn: () => deliverablesApi.list(companyId!, { projectId: projectId!, sort: "newest", limit: PROJECT_DELIVERABLES_LIMIT }),
    enabled: !!companyId && !!projectId,
  });
  const documents = useMemo(
    () => sortLatestFirst(groupDeliverableDocuments(onlyProject(query.data?.deliverables ?? [], projectId ?? ""))),
    [query.data, projectId],
  );
  return { ...query, documents };
}

/** Belt and braces: never show another project's deliverable on this tab. */
export function onlyProject(items: readonly Deliverable[], projectId: string): Deliverable[] {
  return items.filter((item) => item.project?.id === projectId);
}

export function sortLatestFirst<T extends DeliverableDocumentGroup<Deliverable>>(documents: readonly T[]): T[] {
  return [...documents].sort((a, b) => b.latest.createdAt.localeCompare(a.latest.createdAt));
}

export function filterProjectDeliverables<T extends DeliverableDocumentGroup<Deliverable>>(
  documents: readonly T[],
  filter: ProjectDeliverableFilter,
): T[] {
  if (filter === "delivered") return documents.filter((document) => document.latest.stage === "delivered");
  if (filter === "client_facing") return documents.filter((document) => document.latest.confidentiality !== "internal");
  return [...documents];
}

/** Segmented filter: All, Delivered, Client-facing. 44px tall on phones. */
export function ProjectDeliverableFilters({
  value,
  counts,
  onChange,
}: {
  value: ProjectDeliverableFilter;
  counts: Record<ProjectDeliverableFilter, number>;
  onChange: (value: ProjectDeliverableFilter) => void;
}) {
  return (
    <div role="group" aria-label="Show" className="inline-flex max-w-full flex-wrap gap-1 rounded-lg border border-border p-1">
      {FILTERS.map((filter) => (
        <button
          key={filter.value}
          type="button"
          aria-pressed={value === filter.value}
          onClick={() => onChange(filter.value)}
          data-testid={`project-deliverables-filter-${filter.value}`}
          className={cn(
            "inline-flex min-h-11 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-8",
            value === filter.value && "bg-accent text-accent-foreground",
          )}
        >
          {filter.label}
          <span className="text-xs tabular-nums">{counts[filter.value]}</span>
        </button>
      ))}
    </div>
  );
}

/** One deliverable on the project tab: what it is, where it stands, which release, when and who. */
export function ProjectDeliverableCard({
  deliverable,
  earlierCopies = 0,
  onOpen,
}: {
  deliverable: Deliverable;
  /** Older entries for the same document under another key or task. */
  earlierCopies?: number;
  onOpen: () => void;
}) {
  const clientFacing = deliverable.confidentiality !== "internal";
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="project-deliverable-card"
      aria-label={`Open ${deliverable.title}, ${releaseLabel(deliverable.version)}`}
      className="gs-glass-card gs-glass-card-interactive flex min-h-11 w-full min-w-0 flex-col gap-2 rounded-xl border p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="line-clamp-2 text-sm font-semibold leading-5 text-foreground">{deliverable.title}</span>
      <span className="flex flex-wrap items-center gap-1.5">
        <Badge variant="secondary">{DELIVERABLE_KIND_LABELS[deliverable.kind]}</Badge>
        <DeliverableStageBadge stage={deliverable.stage} />
        <Badge
          variant="outline"
          data-testid="project-deliverable-audience"
          className={clientFacing ? "border-status-info/40 bg-status-info-soft text-status-info-foreground" : "text-muted-foreground"}
        >
          {clientFacing ? "Client-facing" : "Internal"}
        </Badge>
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground" data-testid="project-deliverable-release">
          {releaseLabel(deliverable.version)}
        </span>
        {earlierCopies > 0 ? <span>{earlierCopies === 1 ? "1 earlier copy" : `${earlierCopies} earlier copies`}</span> : null}
        <span aria-hidden="true">·</span>
        <time dateTime={deliverable.createdAt}>{formatDate(deliverable.createdAt)}</time>
      </span>
      <span className="mt-auto flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        {deliverable.createdByAgent ? <AgentAvatar agent={deliverable.createdByAgent} size={20} /> : null}
        <span className="truncate">{deliverable.createdByAgent?.name ?? "A person"}</span>
      </span>
    </button>
  );
}

/** The whole tab: filters, cards, and Quick Look in place. */
export function ProjectDeliverablesTab({ companyId, projectId }: { companyId: string; projectId: string }) {
  const { documents, isLoading, error } = useProjectDeliverables(companyId, projectId);
  const [filter, setFilter] = useState<ProjectDeliverableFilter>("all");
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const pushToast = useOptionalToastActions()?.pushToast ?? (() => null);

  const counts = useMemo(() => ({
    all: documents.length,
    delivered: filterProjectDeliverables(documents, "delivered").length,
    client_facing: filterProjectDeliverables(documents, "client_facing").length,
  }), [documents]);
  const shown = useMemo(() => filterProjectDeliverables(documents, filter), [documents, filter]);
  const items = useMemo(() => shown.map((document) => document.latest), [shown]);

  const copyLink = useCallback(async (id: string) => {
    const item = items.find((entry) => entry.id === id);
    try {
      await copyTextToClipboard(new URL(item?.appPath ?? "", window.location.origin).toString());
      pushToast({ title: "Link copied", tone: "success", ttlMs: 2500 });
    } catch {
      pushToast({ title: "Could not copy the link", tone: "error" });
    }
  }, [items, pushToast]);

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading deliverables...</p>;
  if (error) return <p className="text-sm text-status-danger-foreground">The deliverables did not load.</p>;
  if (documents.length === 0) {
    return (
      <EmptyState
        icon={FileCheck2}
        message="Nothing delivered in this project yet."
        description="When an agent or a person files a deliverable on one of this project's tasks, or moves one here, it shows on this tab."
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="project-deliverables">
      <ProjectDeliverableFilters value={filter} counts={counts} onChange={setFilter} />
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {filter === "delivered" ? "Nothing in this project is delivered yet." : "Nothing in this project is client-facing yet."}
        </p>
      ) : (
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((document, index) => (
            <ProjectDeliverableCard
              key={document.key}
              deliverable={document.latest}
              earlierCopies={document.older.length}
              onOpen={() => setOpenIndex(index)}
            />
          ))}
        </div>
      )}
      {openIndex !== null && items[openIndex] ? (
        <DeliverableQuickLook
          companyId={companyId}
          items={items}
          index={openIndex}
          onIndexChange={setOpenIndex}
          onClose={() => setOpenIndex(null)}
          onCopyLink={(id) => void copyLink(id)}
        />
      ) : null}
    </div>
  );
}
